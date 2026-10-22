import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { glob } from 'tinyglobby';
import ts from 'typescript';

import { loadConfig, rulesFor, type ResolvedConfig, type TokenSourceConfig } from './config.js';
import {
  presetResolver,
  registryFolders,
  stylesheetResolver,
  workspaceRootOf,
  type DesignSystemSource,
} from './detect.js';
import {
  extractComponents,
  type ExtractComponentsOptions,
  type ExtractComponentsResult,
} from './extract/components.js';
import { attachDocs, parseDoc, type ParsedDoc } from './extract/docs.js';
import {
  isProjectFile,
  PROJECT_CONFIG_FILES,
  projectFiles,
  readProjectConfig,
} from './extract/program.js';
import { loadLibraries } from './libraries/load.js';
import { checkSource, LintTarget } from './lint/index.js';
import { ModuleResolver } from './modules.js';
import {
  buildSearchIndex,
  searchComponents,
  type Bm25Index,
  type SearchHit,
} from './search/index.js';
import { importedStylesheets } from './tokens/imports.js';
import { loadTokens, type TokenIndex } from './tokens/index.js';
import {
  applyTailwindColors,
  applyTailwindRadii,
  presetStylesheets,
  readTailwindColors,
  readTailwindRadii,
} from './tokens/tailwind-config.js';
import type {
  CheckResult,
  ComponentInfo,
  DesignSystemModel,
  Token,
  TokenCategory,
} from './types.js';
import { silentLogger, type Logger } from './util/log.js';
import { globBase, isHomeOrAbove, isInside, matchesGlob, relativePath } from './util/paths.js';
import { closest, plural, unique } from './util/strings.js';
import { COLOR_UTILITY, parseUtility } from './lint/tailwind.js';
import { VERSION } from './version.js';

/** A loaded design system: the model plus the indexes the tools query. */
export class DesignSystem {
  readonly lint: LintTarget;
  private readonly searchIndex: Bm25Index<ComponentInfo>;
  /**
   * The components the tools offer: all of them, except a library's (MUI's) where the project
   * has its own of that name, a wrapper the team means to be used, and the helpers in a
   * registry folder's `lib/` (signoff-ui's `Img` and icons). The rules still check code that
   * imports either directly against them.
   */
  private readonly offered: ComponentInfo[];
  /** The design systems the rules rank, with the registry folders a config lists. */
  private readonly sources: DesignSystemSource[] | undefined;

  constructor(
    readonly model: DesignSystemModel,
    readonly config: ResolvedConfig,
  ) {
    this.sources = rankedSources(config);
    this.lint = new LintTarget(
      model,
      this.sources === config.designSystems ? config : { ...config, designSystems: this.sources },
      new ModuleResolver(config),
    );
    const own = new Set(
      model.components.filter((c) => !c.library).flatMap((c) => [c.name, ...c.aliases]),
    );
    this.offered = model.components.filter(
      (c) =>
        (!c.library || !(own.has(c.name) || (c.parent !== undefined && own.has(c.parent)))) &&
        !this.registryHelper(c),
    );
    this.searchIndex = buildSearchIndex(this.offered);
  }

  /**
   * The shadcn registry a component was copied from (`@signoff-ui`), when its folder is one
   * components.json names: a read-only design system, whose code is the registry's.
   */
  registryOf(component: ComponentInfo): { registry: string; folder: string } | undefined {
    if (component.library) return undefined;
    const file = component.source.file;
    for (const source of this.sources ?? []) {
      if (!source.registry) continue;
      const glob = source.components.find((g) => matchesGlob(file, g));
      // Its folder, as zero config wrote the glob: `components/signoff-ui/**/*.{tsx,jsx}`.
      const folder = glob?.replace(/\/\*\*\/\*\.\{tsx,jsx\}$/, '').replace(/\\(.)/g, '$1');
      if (folder !== undefined) return { registry: source.registry, folder };
    }
    return undefined;
  }

  /** A component in a registry folder's `lib/`: an internal of its items, not one of them. */
  private registryHelper(component: ComponentInfo): boolean {
    const from = this.registryOf(component);
    return from !== undefined && component.source.file.startsWith(`${from.folder}/lib/`);
  }

  get root(): string {
    return this.model.root;
  }

  get components(): ComponentInfo[] {
    return this.offered;
  }

  get tokens(): Token[] {
    return this.model.tokens;
  }

  get tokenIndex(): TokenIndex {
    return this.lint.tokens;
  }

  /** Top-level components, i.e. not parts of another component. */
  roots(): ComponentInfo[] {
    return this.offered.filter((c) => !c.parent);
  }

  /** Looks a component up by name, alias, `Card.Header`/`CardHeader` or case-insensitively. */
  getComponent(name: string): ComponentInfo | undefined {
    const exact = this.lint.components.get(name);
    if (exact) return exact;
    const key = (n: string) => n.replace(/\./g, '').toLowerCase();
    const wanted = key(name);
    return this.offered.find(
      (c) => key(c.name) === wanted || c.aliases.some((a) => key(a) === wanted),
    );
  }

  suggestComponent(name: string): string | undefined {
    return closest(name, this.lint.names(), 0.5);
  }

  search(query: string, limit = 5): SearchHit[] {
    return searchComponents(this.searchIndex, query, limit);
  }

  /** Tokens, core ones first: scoped families (`sidebar-*`, `chart-*`) follow the rest, which an agent should reach for. */
  getTokens(
    filter: { category?: TokenCategory | undefined; query?: string | undefined } = {},
  ): Token[] {
    const query = filter.query?.toLowerCase();
    return this.model.tokens
      .filter(
        (t) =>
          (!filter.category || t.category === filter.category) &&
          (!query ||
            t.name.toLowerCase().includes(query) ||
            (t.description ?? '').toLowerCase().includes(query) ||
            t.usage.some((u) => u.toLowerCase().includes(query))),
      )
      .sort(
        (a, b) =>
          Number(this.tokenIndex.scopedFamilyOf(a) !== undefined) -
          Number(this.tokenIndex.scopedFamilyOf(b) !== undefined),
      );
  }

  /** Tokens a component's classes and CSS variables reference, e.g. `bg-primary` → `primary`. */
  relatedTokens(component: ComponentInfo): Token[] {
    const byUsage = new Map<string, Token>();
    for (const token of this.model.tokens) {
      for (const usage of token.usage) byUsage.set(usage, token);
    }
    const found = new Map<string, Token>();
    // The spacing unit backs every p-*/gap-* class; listing it says nothing.
    const isUnit = (token: Token) => token.category === 'spacing' && token.tailwind === '';
    for (const cls of component.classNames) {
      const { base } = parseUtility(cls);
      const token = byUsage.get(base) ?? matchUtility(base, this.model.tokens);
      if (token && !isUnit(token)) found.set(token.name, token);
    }
    for (const cssVar of component.cssVars) {
      const token = this.tokenIndex.byCssVar(cssVar);
      if (token) found.set(token.name, token);
    }
    return [...found.values()];
  }

  /**
   * Whether `check --require-design-system` (and the GitHub Action, where it is on by default)
   * finds a design system to check against: components and color tokens, or components from a
   * published library (MUI). A library is the design system whatever its theme: when the theme's
   * colors cannot be read (a palette from Sass variables), the check still runs and `notice()`
   * says that no-hardcoded-color did not.
   */
  hasDesignSystem(): boolean {
    return !this.notice() || this.model.components.some((c) => c.library !== undefined);
  }

  /**
   * What the rules could not check, when it matters: without components the
   * component rules find nothing, and without color tokens neither does
   * no-hardcoded-color, so a clean result says little. Undefined when both exist.
   * `where` names the projects it applies to, at a workspace root: `in apps/web`.
   */
  notice(where?: string): string | undefined {
    const components = this.model.components.length > 0;
    const colors = this.tokenIndex.has('color');
    if (components && colors) return undefined;
    const see = `See ${CONFIGURATION_DOCS}`;
    const at = where ? ` in ${where}` : '';
    if (!components && !colors) {
      const scale =
        this.tokenIndex.has('spacing') || this.tokenIndex.has('radius')
          ? ' and the spacing and radius rules'
          : '';
      return `No design system found${at} (no components or color tokens): only the accessibility rule${scale} ran. ${see}`;
    }
    return components
      ? `No color tokens found${at}: no-hardcoded-color did not run. ${see}`
      : `No design-system components found${at}: the component rules did not run. ${see}`;
  }

  check(code: string, filename?: string): CheckResult {
    return checkSource(code, this.lint, { filename, rules: rulesFor(this.config, filename) });
  }
}

const CONFIGURATION_DOCS = 'https://onsystem.vercel.app/docs/configuration';

/**
 * The design systems the rules rank, first to last: zero config's, or, for a config that lists
 * the folders `npx shadcn add` copies the registries of components.json into (as `init` writes
 * them), its other components first and each such folder after them, read-only, as zero config
 * reads them.
 */
function rankedSources(config: ResolvedConfig): DesignSystemSource[] | undefined {
  if (config.designSystems || !config.configured) return config.designSystems;
  const listed = registryFolders(config.root, config.tsconfig).filter((f) =>
    config.components.some((g) => matchesGlob(`${f.dir}/index.tsx`, g)),
  );
  if (!listed.length) return undefined;
  const inRegistry = (glob: string) => {
    const base = globBase(glob);
    return listed.some((f) => base === f.dir || base.startsWith(`${f.dir}/`));
  };
  return [
    {
      source: 'components',
      components: config.components.filter((g) => !inRegistry(g)),
      imports: 0,
    },
    ...listed.map((f) => ({
      source: `${f.dir} (${f.namespace})`,
      components: [f.glob],
      imports: 0,
      registry: f.namespace,
    })),
  ];
}

/** `border-ring` → token `ring`, for color utilities a token's usage list does not spell out. */
function matchUtility(base: string, tokens: Token[]): Token | undefined {
  const key = COLOR_UTILITY.exec(base)?.[1];
  return key ? tokens.find((t) => t.category === 'color' && t.tailwind === key) : undefined;
}

// ─── Loading ────────────────────────────────────────────────────────────────

export interface LoadOptions {
  /** Use the on-disk extraction cache. Default true. */
  cache?: boolean;
  logger?: Logger;
  /** Previous TypeScript program, reused for incremental rebuilds. */
  oldProgram?: ts.Program | undefined;
}

interface ResolvedFiles {
  components: string[];
  tokens: { file: string; prefix?: string | undefined }[];
  docs: string[];
  /** Files found that lead outside the project, which are not read. */
  outside: string[];
}

/**
 * Where the design system's files may really be, links resolved: the project, the workspace
 * and the git repository it is in, the folder a design-system package's config stays in, and
 * packages reached through a `node_modules` folder in those, which pnpm can link from a store
 * elsewhere. A glob follows links, and a config can name `../` and absolute paths, so without
 * this a cloned repository could have the tools return any file on the machine
 * (`docs/credentials.md` linked to `~/.aws/credentials`).
 */
class Containment {
  /** The folders, as given. */
  private readonly dirs: string[];
  /** The same folders, links resolved. */
  private readonly roots: Promise<string[]>;
  private readonly reals = new Map<string, Promise<string | undefined>>();
  /** Files left out, as they were found. */
  readonly outside = new Set<string>();

  constructor(config: ResolvedConfig) {
    const around = [
      workspaceRootOf(config.root),
      repositoryOf(config.root),
      config.base,
      config.designSystemPackage?.boundary,
    ]
      // Never the home folder or above, which a stray package.json or a repository of
      // dotfiles can make the workspace or repository.
      .filter((dir): dir is string => dir !== undefined && !isHomeOrAbove(dir));
    this.dirs = unique([config.root, ...around].map((dir) => path.resolve(dir)));
    this.roots = Promise.all(this.dirs.map((dir) => this.real(dir))).then((reals) =>
      reals.filter((real): real is string => real !== undefined),
    );
  }

  /** Where `file` really is, links resolved; undefined when it is not there. */
  real(file: string): Promise<string | undefined> {
    let real = this.reals.get(file);
    if (!real) {
      real = fsp.realpath(file).catch(() => undefined);
      this.reals.set(file, real);
    }
    return real;
  }

  /**
   * `files` whose real path is inside, in their order, one path per real file: the shortest,
   * so a folder that links back to its parent does not add its files again.
   */
  async filter(files: readonly string[]): Promise<string[]> {
    const roots = await this.roots;
    const reals = await Promise.all(files.map((file) => this.real(file)));
    const kept = new Map<string, string>();
    files.forEach((file, i) => {
      const real = reals[i];
      if (real === undefined) return;
      const inside =
        roots.some((root) => isInside(root, real)) ||
        (isInstalled(real) && this.inNodeModules(file));
      if (!inside) {
        this.outside.add(file);
        return;
      }
      const previous = kept.get(real);
      if (previous === undefined || file.length < previous.length) kept.set(real, file);
    });
    return [...kept.values()];
  }

  /**
   * Whether `file`, as found, is in a package in a `node_modules` folder of the project, the
   * workspace or the repository, as one pnpm links from its store is. A link elsewhere in the
   * project to another project's `node_modules` is not.
   */
  private inNodeModules(file: string): boolean {
    const found = path.resolve(file);
    return this.dirs.some((dir) => isInside(dir, found) && isInstalled(path.relative(dir, found)));
  }
}

/** Whether a path is a file of a package in `node_modules`, not of `.cache` or `.bin` there. */
function isInstalled(file: string): boolean {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  return at !== -1 && at < parts.length - 2 && !(parts[at + 1] ?? '.').startsWith('.');
}

/** The nearest folder at or above `dir` with a `.git`: the repository it is in. */
function repositoryOf(dir: string): string | undefined {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (current === path.dirname(current)) return undefined;
  }
}

/**
 * `extractComponents`, without the component files nested too deeply for TypeScript's recursive
 * parser (thousands of levels), each named in a warning: one such file would otherwise fail the
 * whole design system with a RangeError that names no file.
 */
function extractReadable(options: ExtractComponentsOptions): ExtractComponentsResult {
  try {
    return extractComponents(options);
  } catch (error) {
    if (!isStackOverflow(error)) throw error;
    const tooDeep = new Set(options.files.filter(overflowsParser));
    // Too deep somewhere else, such as a module the components import: none to leave out.
    if (!tooDeep.size) throw error;
    const extracted = extractComponents({
      ...options,
      files: options.files.filter((file) => !tooDeep.has(file)),
    });
    for (const file of tooDeep) {
      extracted.warnings.push(
        `${relativePath(options.root, file)}: nested too deeply to read (thousands of levels); skipped.`,
      );
    }
    return extracted;
  }
}

/** Whether parsing `file` on its own runs out of stack. */
function overflowsParser(file: string): boolean {
  try {
    ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    return false;
  } catch (error) {
    return isStackOverflow(error);
  }
}

function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}

/** What `inspect` and the server's log say about files that lead outside the project. */
function outsideWarning(root: string, files: readonly string[]): string {
  const shown = files.map((file) => relativePath(root, file)).sort();
  const named =
    shown.length === 1
      ? (shown[0] ?? '')
      : shown.length <= 5
        ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) ?? ''}`
        : `${shown.slice(0, 5).join(', ')} and ${shown.length - 5} more`;
  return `Not read: ${named} ${shown.length === 1 ? 'leads' : 'lead'} outside the project. Links resolved, the design system's files must be in the project, the workspace or git repository it is in, a package installed in their node_modules, or a package that declares its config (run onsystem init in it).`;
}

/**
 * Absolute paths matching `patterns` under the root. `node_modules` is skipped
 * even when `exclude` replaces the defaults, except by patterns that name it
 * (tokens published as a package). Files that lead outside the project are left out.
 */
async function find(
  config: ResolvedConfig,
  patterns: string[],
  contain = new Containment(config),
): Promise<string[]> {
  const options = { cwd: config.root, absolute: true, dot: false };
  // A design-system package's own excludes, when an app's `exclude` adds the defaults to them.
  const exclude = config.designSystemExclude ?? config.exclude;
  const named = patterns.filter((p) => p.includes('node_modules'));
  const outside = patterns.filter((p) => !p.includes('node_modules') && p.startsWith('../'));
  const rest = patterns.filter((p) => !p.includes('node_modules') && !p.startsWith('../'));
  const found = await Promise.all([
    rest.length
      ? glob(rest, { ...options, ignore: unique(['**/node_modules/**', ...exclude]) })
      : [],
    // Without the excludes that leave out all of node_modules (`**/node_modules/**`), keeping
    // those that name files in it: a design-system package's, rebased onto where it is installed.
    named.length
      ? glob(named, {
          ...options,
          ignore: exclude.filter((e) => !/^(?:\*\*\/)?node_modules(?:\/\*\*)?\/?$/.test(e)),
        })
      : [],
    // A workspace package next to the root (`../../packages/ui/...`): `**/` ignore
    // patterns do not match paths that leave the cwd, so glob from the pattern's own
    // base, with the excludes that apply there.
    ...outside.map((pattern) => {
      const base = globBase(pattern);
      const prefix = `${base}/`;
      return glob(pattern.slice(prefix.length) || pattern, {
        ...options,
        cwd: path.resolve(config.root, base),
        ignore: unique([
          '**/node_modules/**',
          ...exclude.filter((e) => e.startsWith('**/')),
          ...exclude.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length)),
        ]),
      });
    }),
  ]);
  return (await contain.filter(unique(found.flat()))).sort();
}

/** The design system's own component files, as absolute paths. */
export function componentFiles(config: ResolvedConfig): Promise<string[]> {
  return find(config, config.components);
}

/** The token files a config finds, as absolute paths. */
export async function tokenFiles(config: ResolvedConfig): Promise<string[]> {
  return (await resolveFiles(config)).tokens.map((t) => t.file);
}

async function resolveFiles(config: ResolvedConfig): Promise<ResolvedFiles> {
  const contain = new Containment(config);
  const components = await find(config, config.components, contain);
  const docs = await find(config, config.docs, contain);
  const tokens: ResolvedFiles['tokens'] = [];
  // By real path: two paths that lead to one stylesheet are one file.
  const seen = new Set<string>();
  const isNew = async (file: string) => {
    const real = (await contain.real(file)) ?? path.resolve(file);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  };
  const add = async (sources: TokenSourceConfig[]) => {
    for (const source of sources) {
      for (const file of await find(config, [source.path], contain)) {
        if (await isNew(file)) tokens.push({ file, prefix: source.prefix });
      }
    }
  };
  await add(config.tokens.filter((t) => !t.fallback));
  if (config.tokensDetected) {
    const found = tokens.map((t) => path.resolve(t.file));
    for (const file of await contain.filter(linkedStylesheets(config, found))) {
      if (await isNew(file)) tokens.push({ file });
    }
  }
  // A DESIGN.md stands in only when no stylesheet or DTCG file was found.
  if (!tokens.length) await add(config.tokens.filter((t) => t.fallback));
  return { components, tokens, docs, outside: [...contain.outside] };
}

/**
 * The stylesheets zero config reads besides the ones it found: those they `@import` (by a
 * path, or from a workspace package: `@import "@acme/theme"`), then those that set the colors
 * a Tailwind v3 config maps, in the workspace package of a shared preset it reads (Dub's
 * `@dub/tailwind-config` and its `themes.css`), with what they import. May repeat a file.
 */
function linkedStylesheets(config: ResolvedConfig, found: string[]): string[] {
  const resolve = stylesheetResolver(config.root, { importPath: config.importPath });
  const preset = config.tailwindConfig
    ? presetStylesheets(
        readTailwindColors(config.tailwindConfig, presetResolver(config.root)),
        config.root,
      )
    : [];
  return [
    ...importedStylesheets(
      found.filter((f) => f.endsWith('.css')),
      resolve,
    ),
    ...preset,
    ...importedStylesheets(preset, resolve),
  ];
}

/** Size and mtime of files, each read once per build. */
class FileStats {
  private readonly stats = new Map<string, Promise<string>>();

  constructor(private readonly root: string) {}

  of(files: readonly string[]): Promise<string[]> {
    return Promise.all(
      files.map((file) => {
        let stat = this.stats.get(file);
        if (!stat) {
          stat = fsp.stat(file).then(
            (s) => `${relativePath(this.root, file)}:${s.size}:${Math.round(s.mtimeMs)}`,
            () => `${file}:missing`,
          );
          this.stats.set(file, stat);
        }
        return stat;
      }),
    );
  }
}

/**
 * Everything that, when changed, invalidates the cached model: the tracked
 * files, `dependencies` (project files the components import and the tsconfig
 * chain, known after extraction), the lockfile, the config and the files left out.
 */
async function cacheKey(
  config: ResolvedConfig,
  files: ResolvedFiles,
  dependencies: readonly string[],
  stats = new FileStats(config.root),
): Promise<string> {
  const extra = [
    ...PROJECT_CONFIG_FILES,
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
  ]
    .map((f) => path.join(config.root, f))
    .filter((f) => fs.existsSync(f));
  const all = unique([
    ...files.components,
    ...files.tokens.map((t) => t.file),
    ...files.docs,
    ...extra,
    ...dependencies,
  ]);
  const { rules: _rules, overrides: _overrides, ...relevant } = config;
  // The files left out too: the model's warning names them, so adding or removing one rebuilds.
  const outside = files.outside.map((file) => relativePath(config.root, file)).sort();
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: VERSION,
        config: relevant,
        outside,
        stats: await stats.of(all),
      }),
    )
    .digest('hex');
}

/**
 * Where the model is cached: the project's `node_modules/.cache`, else (`temp`) a folder of the
 * user's own in the system temp folder, `onsystem-<uid>`.
 */
function cacheFile(root: string): { file: string; temp: boolean } {
  const nodeModules = path.join(root, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    return { file: path.join(nodeModules, '.cache', 'onsystem', 'model.json'), temp: false };
  }
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const user = process.getuid ? `-${process.getuid()}` : '';
  return { file: path.join(os.tmpdir(), `onsystem${user}`, `${id}.json`), temp: true };
}

/**
 * Why the cache folder in the system temp folder cannot be trusted, or undefined when it can: it
 * must be a folder, not a link, that the user owns and no one else can write to. On a multi-user
 * host the temp folder is shared, and a model planted in it would reach the agent. With `create`,
 * it is created (or closed) for the user first. Windows gives each user a temp folder of their own.
 */
async function untrustedCacheFolder(folder: string, create: boolean): Promise<string | undefined> {
  if (!process.getuid) return undefined;
  if (create) await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(folder);
  if (!stat.isDirectory()) return `${folder} is not a folder`;
  if (stat.uid !== process.getuid()) return `${folder} belongs to another user`;
  if (!create && stat.mode & 0o022) return `other users can write to ${folder}`;
  if (create && stat.mode & 0o077) await fsp.chmod(folder, 0o700);
  return undefined;
}

/**
 * Writes `text` beside `file`, then renames it into place: a run reading it never sees half. With
 * `own`, only the user can read it (the temp folder's cache); without, it has the default mode, so
 * a cache in `node_modules` built by one user (a Docker build as root) is still read by another.
 */
async function writeWhole(file: string, text: string, own: boolean): Promise<void> {
  const partial = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(partial, text, own ? { mode: 0o600 } : {});
    await fsp.rename(partial, file);
  } finally {
    await fsp.rm(partial, { force: true });
  }
}

export interface BuildResult {
  model: DesignSystemModel;
  program?: ts.Program | undefined;
  /** Fingerprint of every input file; unchanged fingerprint means nothing to rebuild. */
  key?: string;
  /** Project files the model depends on beyond the tracked ones; pass them to `fingerprint`. */
  dependencies?: string[];
}

/**
 * Fingerprint of the files a config tracks (paths, sizes, mtimes), plus the
 * `dependencies` of a previous build, without extracting anything.
 */
export async function fingerprint(
  config: ResolvedConfig,
  dependencies: readonly string[] = [],
): Promise<string> {
  return cacheKey(config, await resolveFiles(config), dependencies);
}

export async function buildModel(
  config: ResolvedConfig,
  options: LoadOptions = {},
): Promise<BuildResult> {
  const logger = options.logger ?? silentLogger;
  const started = performance.now();
  const files = await resolveFiles(config);
  const useCache = options.cache !== false;
  const { file: cachePath, temp } = cacheFile(config.root);

  let cached: { key?: string; dependencies?: string[]; model?: DesignSystemModel } | undefined;
  if (useCache && !options.oldProgram) {
    try {
      const untrusted = temp && (await untrustedCacheFolder(path.dirname(cachePath), false));
      if (!untrusted) cached = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as typeof cached;
    } catch {
      // No cache yet, or unreadable: extract.
    }
  }
  const known = Array.isArray(cached?.dependencies)
    ? cached.dependencies
    : options.oldProgram
      ? projectFiles(options.oldProgram)
      : [];
  // Stat every input known up front before extracting, so a file saved
  // during the build still changes the next fingerprint.
  const stats = new FileStats(config.root);
  const before = await cacheKey(config, files, known, stats);
  if (cached?.model?.version === 1 && cached.key === before && Array.isArray(cached.dependencies)) {
    cached.model.stats.fromCache = true;
    cached.model.stats.durationMs = Math.round(performance.now() - started);
    return { model: cached.model, key: before, dependencies: cached.dependencies };
  }

  const extracted = extractReadable({
    root: config.root,
    files: files.components,
    tsconfig: config.tsconfig,
    importPath: config.importPath,
    imports: config.imports,
    oldProgram: options.oldProgram,
  });
  const docs: ParsedDoc[] = [];
  const warnings = [...extracted.warnings];
  if (files.outside.length) warnings.push(outsideWarning(config.root, files.outside));
  for (const file of files.docs) {
    try {
      docs.push(parseDoc(await fsp.readFile(file, 'utf8'), relativePath(config.root, file)));
    } catch (error) {
      warnings.push(`${relativePath(config.root, file)}: ${(error as Error).message}`);
    }
  }
  warnings.push(...attachDocs(extracted.components, docs));
  const tokens = await loadTokens(config.root, files.tokens);
  warnings.push(...tokens.warnings);
  // Published libraries the project uses (MUI), from their type declarations, after the
  // project's own components, and the tokens of the theme it gives them.
  const libraries = await loadLibraries(config);
  warnings.push(...libraries.warnings);
  tokens.tokens.push(...libraries.tokens);
  // Tailwind v3 maps color classes in its config rather than in `@theme`.
  const tailwind = config.tailwindConfig
    ? readTailwindColors(config.tailwindConfig, presetResolver(config.root))
    : undefined;
  if (tailwind) applyTailwindColors(tokens.tokens, tailwind.colors, tailwind.rgb);
  // Same for radius: v3 borderRadius entries (config, then presets) name the scale.
  let radiiFiles: string[] = [];
  if (config.tailwindConfig) {
    const radii = readTailwindRadii(config.tailwindConfig, presetResolver(config.root));
    applyTailwindRadii(tokens.tokens, radii.radii, config.tailwindConfig);
    radiiFiles = radii.files;
  }

  if (!files.components.length && !libraries.components.length) {
    warnings.push(
      `No component files matched ${config.components.join(', ')} under ${config.root}`,
    );
  }
  if (!files.tokens.length && !libraries.tokens.length) {
    warnings.push('No token files found; token rules are disabled.');
  }

  const model: DesignSystemModel = {
    version: 1,
    root: config.root,
    components: [...extracted.components, ...libraries.components],
    tokens: tokens.tokens,
    propSets: { ...extracted.propSets, ...libraries.propSets },
    exports: unique([...extracted.exports, ...libraries.exports]).sort(),
    warnings,
    sources: files.components.map((file) => relativePath(config.root, file)),
    stats: {
      files: {
        components: files.components.length,
        tokens: files.tokens.length,
        docs: files.docs.length,
      },
      durationMs: Math.round(performance.now() - started),
      fromCache: false,
    },
  };

  const dependencies = unique([
    ...extracted.dependencies,
    ...(tailwind?.files ?? []),
    ...radiiFiles,
    ...libraries.dependencies,
  ]);
  const key = await cacheKey(config, files, dependencies, stats);
  if (useCache) {
    try {
      const folder = path.dirname(cachePath);
      let untrusted: string | undefined;
      if (temp) untrusted = await untrustedCacheFolder(folder, true);
      else await fsp.mkdir(folder, { recursive: true });
      if (untrusted) {
        logger.warn(
          `not caching the model: ${untrusted}. Install the project's dependencies, so the cache goes in node_modules, or set TMPDIR to a folder of your own.`,
        );
      } else {
        await writeWhole(cachePath, JSON.stringify({ key, dependencies, model }), temp);
      }
    } catch (error) {
      logger.warn(`could not write cache ${cachePath}: ${(error as Error).message}`);
    }
  }
  return { model, program: extracted.program, key, dependencies };
}

export async function loadDesignSystem(
  config: ResolvedConfig,
  options: LoadOptions = {},
): Promise<DesignSystem> {
  const { model } = await buildModel(config, options);
  return new DesignSystem(model, config);
}

// ─── Host: lazy load, reload on change ──────────────────────────────────────

/**
 * Owns the current DesignSystem. Loads lazily, rebuilds when watched files
 * change (reusing the previous TypeScript program), and never serves a
 * half-built model: callers get the in-flight build when one is running.
 */
export interface HostOptions extends LoadOptions {
  /** Builds the model; replaceable in tests. Defaults to `buildModel`. */
  build?: typeof buildModel;
  /**
   * Re-reads the config when its file changes while watching. Defaults to
   * loading the same config file; pass your own to keep overrides such as CLI flags.
   */
  loadConfig?: () => Promise<ResolvedConfig>;
}

/** Files zero-config detection reads in the root. */
const DETECTION_FILES = ['components.json', 'package.json'];

export class DesignSystemHost {
  private current?: Promise<DesignSystem>;
  private program?: ts.Program | undefined;
  private key?: string | undefined;
  private dependencies: string[] = [];
  /** Bumped by every build; only the latest may update the state above. */
  private generation = 0;
  private configChanged = false;
  private watchers: fs.FSWatcher[] = [];
  /** Recursively watched directories, and the config files watched through their directory. */
  private watchedRoots: string[] = [];
  private readonly watchedDirs = new Set<string>();
  private readonly watchedFiles = new Set<string>();
  private timer?: NodeJS.Timeout;
  private readonly listeners = new Set<(ds: DesignSystem) => void>();

  constructor(
    private config: ResolvedConfig,
    private readonly options: HostOptions = {},
  ) {}

  get(): Promise<DesignSystem> {
    this.current ??= this.build(false);
    return this.current;
  }

  reload(): Promise<DesignSystem> {
    const next = this.build(true);
    // Keep serving the previous model if the rebuild fails.
    const previous = this.current;
    this.current = next.catch(async (error: unknown) => {
      (this.options.logger ?? silentLogger).error(`reload failed: ${(error as Error).message}`);
      if (previous) return previous;
      throw error;
    });
    return this.current;
  }

  onChange(listener: (ds: DesignSystem) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Watches the component, token and docs locations, the config and the tsconfig chain. */
  watch(): void {
    if (this.watchers.length) return;
    const { root } = this.config;
    const dirs = new Set<string>();
    for (const pattern of [
      ...this.config.components,
      ...this.config.docs,
      ...this.config.tokens.map((t) => t.path),
    ]) {
      const base = path.resolve(root, globBase(pattern));
      // Outside the root is fine (a workspace package); an ancestor would watch the whole repository.
      const ancestor = base !== root && isInside(base, root);
      if (!ancestor && fs.existsSync(base)) dirs.add(base);
    }
    // Skip dirs nested inside another watched dir.
    this.watchedRoots = [...dirs].filter((d) => ![...dirs].some((o) => o !== d && isInside(o, d)));
    for (const dir of this.watchedRoots) {
      this.watchDirectory(dir, true, (file) => {
        if (file && /node_modules|\.git[\\/]/.test(file)) return;
        this.changed(file ? path.join(dir, file) : path.join(dir, '.'));
      });
    }
    this.watchConfigFiles();
  }

  /**
   * Watches the config file, the tsconfig and the tsconfigs it extends through
   * their directories: editors save by renaming a new file over the old one,
   * which ends a watch on the file. Called again after each build, so a new
   * `extends` target is picked up.
   */
  private watchConfigFiles(): void {
    const { root, configFile, tsconfig, designSystemPackage } = this.config;
    const files = [
      configFile,
      // The design-system package's package.json, which names its config.
      designSystemPackage && path.join(designSystemPackage.dir, 'package.json'),
      // Zero-config detection reads these; a change re-runs it.
      ...DETECTION_FILES.map((f) => path.join(root, f)),
      ...(tsconfig
        ? [path.resolve(root, tsconfig)]
        : PROJECT_CONFIG_FILES.map((f) => path.join(root, f))),
      // Installed bases (`@tsconfig/next`) change with the lockfile, which the fingerprint covers.
      ...readProjectConfig(root, tsconfig).configFiles.filter(isProjectFile),
    ]
      .filter((f): f is string => Boolean(f))
      .map((f) => path.resolve(f));
    for (const file of files) this.watchedFiles.add(file);
    for (const dir of unique(files.map((f) => path.dirname(f)))) {
      if (this.watchedDirs.has(dir) || this.watchedRoots.some((r) => isInside(r, dir))) continue;
      if (!fs.existsSync(dir)) continue;
      this.watchedDirs.add(dir);
      this.watchDirectory(dir, false, (file) => {
        const full = file ? path.join(dir, file) : undefined;
        if (full === undefined || this.watchedFiles.has(full)) this.changed(full);
      });
    }
  }

  private changed(file: string | undefined): void {
    // Without component globs in the config, the design system was detected from
    // components.json, package.json and tsconfig paths: re-read the config so detection runs again.
    const { root, configFile, detected, designSystemPackage } = this.config;
    if (
      file === undefined ||
      file === configFile ||
      (designSystemPackage !== undefined && this.watchedFiles.has(file)) ||
      (path.dirname(file) === root && DETECTION_FILES.includes(path.basename(file))) ||
      (detected !== undefined && this.watchedFiles.has(file))
    ) {
      this.configChanged = true;
    }
    this.schedule();
  }

  close(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.watchedRoots = [];
    this.watchedDirs.clear();
    this.watchedFiles.clear();
  }

  private watchDirectory(
    dir: string,
    recursive: boolean,
    onChange: (file: string | null) => void,
  ): void {
    try {
      // Non-persistent: the process lives as long as stdin, not as long as the watchers.
      const watcher = fs.watch(dir, { recursive, persistent: false }, (_event, file) => {
        onChange(file);
      });
      watcher.on('error', () => undefined);
      this.watchers.push(watcher);
    } catch {
      // Recursive watch unsupported here; changes need a restart.
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.configChanged) {
        this.configChanged = false;
        void this.reloadConfig();
        return;
      }
      // Watched directories can hold unrelated files (a token file in app/ puts
      // every page under watch), so only rebuild when a tracked file changed.
      fingerprint(this.config, this.dependencies)
        .then(
          (key) => (key === this.key ? undefined : this.reload()),
          () => this.reload(),
        )
        .catch(() => undefined);
    }, 150);
  }

  /** Re-reads the config, re-watches what it points at and rebuilds. */
  private async reloadConfig(): Promise<void> {
    const { root, configFile, designSystemPackage, warnings } = this.config;
    // A design-system package's config is found again from the project, so it is rebased again.
    const load =
      this.options.loadConfig ??
      (() => loadConfig({ root, config: designSystemPackage ? undefined : configFile }));
    try {
      this.config = await load();
    } catch (error) {
      (this.options.logger ?? silentLogger).error(
        `config reload failed: ${(error as Error).message}`,
      );
      return;
    }
    // Said when the project loaded; only what the new config adds is said again.
    for (const text of this.config.warnings ?? []) {
      if (!warnings?.includes(text)) (this.options.logger ?? silentLogger).warn(text);
    }
    if (this.watchers.length) {
      this.close();
      this.watch();
    }
    await this.reload().catch(() => undefined);
  }

  private async build(incremental: boolean): Promise<DesignSystem> {
    const generation = ++this.generation;
    const config = this.config;
    const logger = this.options.logger ?? silentLogger;
    const build = this.options.build ?? buildModel;
    const { model, program, key, dependencies } = await build(config, {
      ...this.options,
      oldProgram: incremental ? this.program : undefined,
    });
    const ds = new DesignSystem(model, config);
    // A newer build started meanwhile: its result is the current one.
    if (generation !== this.generation) return ds;
    if (program) this.program = program;
    this.key = key;
    this.dependencies = dependencies ?? [];
    if (this.watchers.length) this.watchConfigFiles();
    const { stats } = model;
    // Counted as inspect and list_components count them: `4 components (+6 parts)`.
    const roots = ds.roots().length;
    const parts = ds.components.length - roots;
    logger.info(
      `${incremental ? 'reloaded' : 'loaded'} ${plural(roots, 'component')}${parts ? ` (+${plural(parts, 'part')})` : ''}, ${plural(model.tokens.length, 'token')}` +
        ` from ${relativePath(process.cwd(), config.root) || '.'} in ${stats.durationMs}ms${stats.fromCache ? ' (cache)' : ''}`,
    );
    for (const warning of model.warnings) logger.warn(warning);
    if (incremental) for (const listener of this.listeners) listener(ds);
    return ds;
  }
}
