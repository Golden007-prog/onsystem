import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as z from 'zod';

import {
  declaredConfig,
  detectProject,
  findDesignSystemPackage,
  PackageFinder,
  packageImports,
  PACKAGE_FIELD,
  type DesignSystemPackage,
  type DesignSystemPackageLookup,
  type DesignSystemSource,
  type ImportMapping,
} from './detect.js';
import {
  detectLibraries,
  LIBRARY_IDS,
  type LibraryId,
  type LibrarySource,
} from './libraries/index.js';
import { findTailwindConfig } from './tokens/tailwind-config.js';
import {
  coveredByGlob,
  globBase,
  isInside,
  matchesGlob,
  slashGlob,
  toPosix,
} from './util/paths.js';
import { closest } from './util/strings.js';

export const RULE_IDS = [
  'no-hardcoded-color',
  'no-hardcoded-spacing',
  'no-hardcoded-radius',
  'prefer-design-system-component',
  'no-unknown-component',
  'no-unknown-prop',
  'no-unknown-variant',
  'icon-button-accessible-name',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

const SEVERITIES = ['off', 'warn', 'error'] as const;
const severitySchema = z.enum(SEVERITIES);
export type RuleSeverity = z.infer<typeof severitySchema>;

/** Names keys a strict object or record does not know, with the closest known one. */
function unknownKeys(what: string, known: readonly string[]) {
  return (issue: z.core.$ZodRawIssue): string | undefined => {
    if (issue.code !== 'unrecognized_keys') return undefined;
    return issue.keys
      .map((key) => {
        const guess = closest(key, known, 0.5);
        return `Unknown ${what} "${key}". ${guess ? `Did you mean "${guess}"?` : `Expected one of: ${known.join(', ')}.`}`;
      })
      .join('\n');
  };
}

const ruleOptionsShape = {
  allow: z
    .array(z.string())
    .optional()
    .describe('Values the rule accepts anyway: colors, lengths, element or component names.'),
};
const ruleOptionsSchema = z.strictObject(ruleOptionsShape, {
  error: unknownKeys('rule option', Object.keys(ruleOptionsShape)),
});
export type RuleOptions = z.infer<typeof ruleOptionsSchema>;

const ruleSettingSchema = z.union(
  [severitySchema, z.tuple([severitySchema]), z.tuple([severitySchema, ruleOptionsSchema])],
  {
    // `"warning"` otherwise reads "Invalid input"; arrays keep their own, more precise issues.
    error: (issue) => {
      if (typeof issue.input !== 'string') return undefined;
      const input = issue.input;
      const guess = SEVERITIES.find((s) => input && (s.startsWith(input) || input.startsWith(s)));
      return `Invalid severity "${input}": use "off", "warn" or "error"${guess ? ` (did you mean "${guess}"?)` : ''}.`;
    },
  },
);

const globsSchema = z.union([z.string(), z.array(z.string())]);

const rulesSchema = z.partialRecord(z.enum(RULE_IDS), ruleSettingSchema, {
  error: unknownKeys('rule', RULE_IDS),
});

const overrideShape = {
  files: globsSchema.describe(
    'Globs, relative to the root, of the files these rules apply to: "app/legacy/**", "**/*.generated.tsx".',
  ),
  rules: rulesSchema.describe('Rule severities and options for those files, over "rules".'),
};
const overrideSchema = z.strictObject(overrideShape, {
  error: unknownKeys('override key', Object.keys(overrideShape)),
});
const tokenSourceSchema = z.union([
  z.string(),
  z
    .object({
      path: z.string().describe('File or glob.'),
      prefix: z
        .string()
        .optional()
        .describe('DTCG only: custom property prefix, e.g. "acme" for --acme-color-primary.'),
    })
    .strict(),
]);

/** `false`, or a list of library ids; an unknown id is named with the closest known one. */
const librariesSchema = z.union([z.literal(false), z.array(z.enum(LIBRARY_IDS))], {
  error: (issue) => {
    const unknown = Array.isArray(issue.input)
      ? (issue.input as unknown[]).find((id) => !(LIBRARY_IDS as readonly unknown[]).includes(id))
      : undefined;
    if (typeof unknown === 'string') {
      const guess = closest(unknown, LIBRARY_IDS, 0.5);
      return `Unknown library "${unknown}". ${guess ? `Did you mean "${guess}"?` : `Expected one of: ${LIBRARY_IDS.join(', ')}.`}`;
    }
    return `"libraries" is false, to read no library, or a list of the ones to read: ${JSON.stringify(LIBRARY_IDS)}.`;
  },
});

const configShape = {
  $schema: z.string().optional(),
  extends: z
    .boolean()
    .optional()
    .describe(
      'Whether this config builds on the one a design-system package declares ("onsystem" in the package.json of a dependency): what it leaves out comes from there (components with their importPath, docs and elements; tokens; libraries), and its rules apply over the package\'s. Default: true. false reads this config alone.',
    ),
  components: globsSchema
    .optional()
    .describe('Globs for component source files, relative to the root.'),
  exclude: z
    .array(z.string())
    .optional()
    .describe(
      'Globs for files to leave out, relative to the root: `check` in folders and globs, the ESLint plugin, the Claude Code hook and check_ui leave them out, and finding components skips them. A folder (`app/legacy`) covers everything in it. Adds to the defaults (node_modules, .d.ts files, tests and stories); a pattern that starts with `!` takes out the default it names, such as `!**/*.d.ts`.',
    ),
  tokens: z
    .union([tokenSourceSchema, z.array(tokenSourceSchema)])
    .optional()
    .describe(
      "Token files: W3C DTCG JSON (*.json), CSS custom properties (*.css) or a DESIGN.md's front matter (*.md).",
    ),
  docs: globsSchema.optional().describe('Globs for per-component Markdown/MDX docs.'),
  tsconfig: z.string().optional().describe('tsconfig used to resolve types and path aliases.'),
  importPath: z
    .string()
    .optional()
    .describe(
      'Package name components are imported from, e.g. "@acme/ui", or a pattern for packages imported by path: "@acme/ui/{path}" is @acme/ui/primitives/button for primitives/button.tsx in the package. An installed dependency it names exactly, whose component sources the project does not read, is read from its type declarations (.d.ts). Default: inferred from package exports and tsconfig paths.',
    ),
  elements: z
    .record(z.string(), z.string())
    .optional()
    .describe('Extra native element → component mappings, e.g. { "a": "Link" }.'),
  libraries: librariesSchema
    .optional()
    .describe(
      `Published component libraries to read from their type declarations when the project depends on them. Omitted: every one onsystem reads (${LIBRARY_IDS.join(', ')}). false: none. A list: only those, e.g. ["mui"].`,
    ),
  includeDesignSystem: z
    .boolean()
    .optional()
    .describe(
      "check: lint the design system's own component files too. Off by default: they implement the scale and primitives the rules enforce.",
    ),
  rules: rulesSchema
    .optional()
    .describe('Rule severities and options: "off" | "warn" | "error" | [severity, { allow }].'),
  overrides: z
    .array(overrideSchema)
    .optional()
    .describe(
      'Rules for some files: [{ "files": ["app/legacy/**"], "rules": { "no-hardcoded-color": "warn" } }]. Later entries win.',
    ),
};

export const configSchema = z.strictObject(configShape, {
  error: unknownKeys('config key', Object.keys(configShape)),
});

export type Config = z.input<typeof configSchema>;

/** Identity helper for typed `onsystem.config.ts` files. */
export function defineConfig(config: Config): Config {
  return config;
}

export interface TokenSourceConfig {
  path: string;
  prefix?: string | undefined;
  /** Read only when no other source finds a token file (zero config's `DESIGN.md`). */
  fallback?: boolean | undefined;
}

export interface ResolvedRule {
  severity: RuleSeverity;
  options: RuleOptions;
}

/** Rule settings for the files that match `files` (root-relative globs). */
export interface ResolvedOverride {
  files: string[];
  rules: Partial<Record<RuleId, ResolvedRule>>;
}

export interface ResolvedConfig {
  root: string;
  configFile?: string | undefined;
  components: string[];
  /** What `check`, the ESLint plugin and the hook leave out of the project's own files. */
  exclude: string[];
  /**
   * What finding the design system's own files (components, tokens, docs) leaves out, when it
   * is not `exclude`: a design-system package's own list, rebased onto the package. An app that
   * takes on the package's config leaves out the default `exclude` patterns as well.
   */
  designSystemExclude?: string[] | undefined;
  tokens: TokenSourceConfig[];
  /**
   * `tokens` comes from zero config (detection or the default paths), not the config or
   * `--tokens`: the stylesheets those files import are read too, and so are the ones in a
   * shared Tailwind preset's workspace package that set the colors the config maps.
   */
  tokensDetected?: boolean | undefined;
  docs: string[];
  tsconfig?: string | undefined;
  importPath?: string | undefined;
  /** Import specifiers for component files, from the `exports` of the package that holds them. */
  imports?: ImportMapping[] | undefined;
  /** How the design system was found when the config does not say (`components.json`, a workspace package). */
  detected?: string | undefined;
  /**
   * Several design systems found at once, the most imported first: its components win
   * where two share a name, and are the ones suggested for native elements.
   */
  designSystems?: DesignSystemSource[] | undefined;
  /** A Tailwind v3 config, which maps color classes to custom properties (`primary` → `hsl(var(--primary))`). */
  tailwindConfig?: string | undefined;
  /**
   * Published component libraries the project depends on, read from their type declarations
   * (MUI), whatever the config says about `components`: their components are checked where
   * the code imports them, and the project's own components win a shared name.
   */
  libraries?: LibrarySource[] | undefined;
  /**
   * The config's `libraries`: the ids of the libraries to read, or false for none. Undefined
   * reads every library onsystem supports.
   */
  libraryIds?: false | LibraryId[] | undefined;
  /** Libraries the project depends on that `libraries` leaves out, so they are not read. */
  librariesOff?: LibrarySource[] | undefined;
  /** Component libraries the project depends on that onsystem does not read yet (Chakra UI). */
  librariesUnread?: LibrarySource[] | undefined;
  elements: Record<string, string>;
  /** `check` lints the component files themselves, which it skips by default. */
  includeDesignSystem: boolean;
  rules: Record<RuleId, ResolvedRule>;
  /** Per-file rule settings, applied in order over `rules`. */
  overrides?: ResolvedOverride[] | undefined;
  /**
   * The folder `overrides` globs are relative to, when it is not the root: the workspace
   * root, for a project that takes its settings from a config there.
   */
  base?: string | undefined;
  /**
   * The design-system package whose config this project reads: a dependency whose package.json
   * declares it (`"onsystem": "./onsystem.config.json"`). A project with no config of its own
   * takes it on (`configFile` is the package's); one with a config of its own, or a workspace
   * root's, reads it under that one (`configFile` is that one), unless it sets `"extends": false`.
   * Its paths are rebased from the package; its `tsconfig`, `overrides` and
   * `includeDesignSystem` stay with it.
   */
  designSystemPackage?: DesignSystemPackage | undefined;
  /** `components` comes from the config file or `--components`, not from detection or the defaults. */
  configured?: boolean | undefined;
  /**
   * What to tell the user about the config's name: a config file found under its name from
   * before the rename to onsystem. The CLI prints these once per run, the server logs them once.
   */
  deprecations?: string[] | undefined;
  /**
   * What to tell the user about a design-system package's config: one installed from a
   * registry whose declaration cannot be read, which was skipped, or paths in one that point
   * outside it, which were ignored. The CLI prints these once per run, the server logs them
   * once, and the ESLint plugin writes them once to stderr.
   */
  warnings?: string[] | undefined;
}

/** Config file names, in the order they are looked for. */
export const CONFIG_FILES = [
  'onsystem.config.json',
  'onsystem.config.ts',
  'onsystem.config.mts',
  'onsystem.config.js',
  'onsystem.config.mjs',
];

/**
 * The same names from before the package was renamed from design-system-mcp to onsystem.
 * They are still read, when no `onsystem.config.*` exists, with a notice to rename the file.
 */
export const LEGACY_CONFIG_FILES = CONFIG_FILES.map((name) =>
  name.replace(/^onsystem\./, 'design-system-mcp.'),
);

export const DEFAULT_COMPONENTS = [
  'components/ui/**/*.{tsx,jsx}',
  'src/components/ui/**/*.{tsx,jsx}',
];
/** Tests and stories: neither component sources nor UI that `check` lints by default. */
export const DEFAULT_TEST_EXCLUDE = '**/*.{test,spec,stories}.{ts,tsx,js,jsx}';
/** Folders of tests, stories and mocks, whatever their files are called (Twenty's `__stories__/ToastControls.tsx`). */
export const DEFAULT_TEST_FOLDERS = '**/__{tests,stories,mocks}__/**';
export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/*.d.ts',
  DEFAULT_TEST_EXCLUDE,
  DEFAULT_TEST_FOLDERS,
];
export const DEFAULT_TOKENS = [
  'app/globals.css',
  'src/app/globals.css',
  'styles/globals.css',
  'src/styles/globals.css',
  'src/index.css',
  'app/app.css',
  '**/*.tokens.json',
];
/**
 * Zero config reads these only when none of the token files above exist: the tokens in a
 * DESIGN.md's front matter, which describes a design system to agents.
 */
export const FALLBACK_TOKENS = ['DESIGN.md'];
export const DEFAULT_DOCS = [
  'docs/components/**/*.{md,mdx}',
  'components/ui/**/*.{md,mdx}',
  'src/components/ui/**/*.{md,mdx}',
];

export const DEFAULT_SEVERITY: Record<RuleId, RuleSeverity> = {
  'no-hardcoded-color': 'error',
  'no-hardcoded-spacing': 'warn',
  'no-hardcoded-radius': 'warn',
  'prefer-design-system-component': 'error',
  'no-unknown-component': 'error',
  'no-unknown-prop': 'error',
  'no-unknown-variant': 'error',
  'icon-button-accessible-name': 'error',
};

export interface LoadConfigOptions {
  /** Where to look for a config file when `root` and `config` are not given. */
  cwd?: string;
  /** Project root. Defaults to the config file's directory, then `cwd`. */
  root?: string | undefined;
  /** Explicit config file path. */
  config?: string | undefined;
  /**
   * The folder the config file's paths and globs are written relative to, when it is not
   * the root: a workspace root whose config a project in it takes on.
   */
  base?: string | undefined;
  /** CLI overrides; replace the config file's values when set. */
  components?: string[] | undefined;
  tokens?: string[] | undefined;
  docs?: string[] | undefined;
  includeDesignSystem?: boolean | undefined;
  /**
   * Read a JSON config only: a JavaScript or TypeScript config is an error rather than run.
   * For a project the MCP server found from the path a tool call names, which a prompt can
   * choose, unlike the folder the server was started in.
   */
  jsonConfigOnly?: boolean | undefined;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  return loadConfigWith(options);
}

/** What one load shares with the code that started it, so nothing is looked up twice. */
export interface LoadContext {
  /** The finder for the folder searched, shared by the design-system package lookup and detection. */
  packages?: PackageFinder | undefined;
  /** The design-system package lookup, when the caller has already made it for the folder searched. */
  lookup?: DesignSystemPackageLookup | undefined;
}

/** {@link loadConfig}, with what the caller has already found in the folder searched. */
export async function loadConfigWith(
  options: LoadConfigOptions,
  context: LoadContext = {},
): Promise<ResolvedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const searchDir = options.root ? path.resolve(cwd, options.root) : cwd;
  const deprecations: string[] = [];
  const warnings: string[] = [];
  let packages = context.packages?.root === searchDir ? context.packages : undefined;
  const finder = (dir: string) =>
    packages?.root === dir ? packages : (packages = new PackageFinder(dir));
  let lookup = context.lookup;
  /**
   * The project's own config: a config file in the folder searched, `--config`, or a workspace
   * root's that a project in it takes on.
   */
  let configFile: string | undefined;
  if (options.config) {
    configFile = path.resolve(cwd, options.config);
  } else {
    const find = (names: readonly string[]) =>
      names.map((name) => path.join(searchDir, name)).find((file) => fs.existsSync(file));
    configFile = find(CONFIG_FILES);
    const legacy = find(LEGACY_CONFIG_FILES);
    if (legacy) deprecations.push(legacyConfigNotice(legacy, configFile));
    configFile ??= legacy ?? ownDeclaredConfig(searchDir);
  }
  const config: ParsedConfig = configFile ? await readConfig(configFile, options) : {};
  // An explicit --config sets the root by its folder; one found by name is in the folder searched.
  const root = options.root
    ? path.resolve(cwd, options.root)
    : options.config && configFile
      ? path.dirname(configFile)
      : searchDir;
  if (!isDirectory(root)) throw new ConfigError(`Project root not found: ${root}`);

  // The design-system package a dependency declares a config for: a project with no config of
  // its own takes it on, and one with a config of its own reads it under that one.
  let declared: DesignSystemPackage | undefined;
  if (config.extends !== false) {
    lookup ??= findDesignSystemPackage(root, finder(root));
    if (!lookup?.problems.length) {
      declared = lookup?.found;
    } else if (!configFile) {
      throw declarationError(lookup, root);
    } else {
      // The project's own config still works on its own; the package's team can fix theirs.
      warnings.push(
        `${lookup.problems.map((p) => `${p.name}: ${p.problem}`).join('\n')}\nSo ${configFile} is read alone, without the config a design-system package declares. Fix the "${PACKAGE_FIELD}" field in that package, or set "extends": false in ${path.basename(configFile)}.`,
      );
    }
  }
  // Installed packages whose declaration cannot be read: the project is read as if they had none.
  for (const { name, problem } of lookup?.skipped ?? []) {
    warnings.push(
      `${name}'s onsystem config was skipped: ${problem} ${name} is installed in node_modules, so this project is read as if it declared none.`,
    );
  }
  const pkg: ParsedConfig | undefined = declared
    ? await readConfig(declared.config, options)
    : undefined;

  // A workspace root's config, taken on by a project in it: its paths are relative to the
  // workspace root. Files and token globs are rebased onto the project's folder; `exclude`
  // keeps the patterns that can match in it; `overrides` are matched from the workspace root.
  // A design-system package's config: its paths are relative to the package, and `exclude`
  // keeps every pattern, rebased onto the package.
  const base = options.base ? path.resolve(cwd, options.base) : root;
  const rebase =
    (from: string) =>
    (p: string): string =>
      from === root ? p : toPosix(path.relative(root, path.resolve(from, slashGlob(p)))) || '.';
  const fromBase = rebase(base);
  const fromPackage = rebase(declared?.dir ?? root);
  const toProject = toPosix(path.relative(base, root));
  const excludeFromBase = (e: string): string | undefined => {
    if (base === root || e.startsWith('**/')) return e;
    // The project's own folder (`apps/web`) leaves out all of it, as `apps/web/**` does.
    if (e === toProject) return '**';
    return e.startsWith(`${toProject}/`) ? e.slice(toProject.length + 1) : undefined;
  };
  const excludeFromPackage = (e: string) => (e.startsWith('**/') ? e : fromPackage(e));
  // A dependency's config reads only within its package when installed, or its workspace: a
  // path that leaves it is ignored, so a published package cannot have its apps read files
  // elsewhere on the machine.
  const outside: string[] = [];
  const within = (field: string) => (p: string) => {
    if (!declared || staysIn(declared.dir, declared.boundary, slashGlob(p))) return true;
    outside.push(`${field} ${p}`);
    return false;
  };
  const pathOf = (t: TokenSource) => (typeof t === 'string' ? t : t.path);
  const tokensFrom =
    (move: (p: string) => string) =>
    (t: TokenSource): TokenSourceConfig =>
      typeof t === 'string' ? { path: move(t) } : { ...t, path: move(t.path) };
  const packageComponents =
    pkg?.components === undefined
      ? undefined
      : toArray(pkg.components).filter(within('components')).map(fromPackage);
  const packageTokens =
    pkg?.tokens === undefined
      ? undefined
      : toArray(pkg.tokens)
          .filter((t) => within('tokens')(pathOf(t)))
          .map(tokensFrom(fromPackage));
  const packageDocs =
    pkg?.docs === undefined ? undefined : toArray(pkg.docs).filter(within('docs')).map(fromPackage);
  if (declared && outside.length) {
    warnings.push(
      `${declared.name}'s onsystem config names paths outside ${declared.installed ? 'the package' : 'the workspace'}, which were ignored: ${outside.join(', ')}.`,
    );
  }
  // The design system's components, and what goes with them (importPath, docs, elements), come
  // from the package's config unless this one names components of its own.
  const inherits = pkg !== undefined && config.components === undefined;
  const configComponents =
    config.components === undefined ? packageComponents : toArray(config.components).map(fromBase);
  const configTokens =
    config.tokens === undefined ? packageTokens : toArray(config.tokens).map(tokensFrom(fromBase));
  const configDocs =
    config.docs === undefined
      ? inherits
        ? packageDocs
        : undefined
      : toArray(config.docs).map(fromBase);
  const importPath = config.importPath ?? (inherits ? pkg.importPath : undefined);
  const librariesSetting = config.libraries ?? pkg?.libraries;

  // The package's rules, then this config's over them.
  const rules = {} as Record<RuleId, ResolvedRule>;
  for (const id of RULE_IDS) {
    const setting = config.rules?.[id] ?? pkg?.rules?.[id];
    rules[id] =
      setting === undefined
        ? { severity: DEFAULT_SEVERITY[id], options: {} }
        : resolveRule(setting);
  }
  // A package's `overrides` are about its own files, which an app does not check.
  const overrides: ResolvedOverride[] = (config.overrides ?? []).map((override) => ({
    files: toArray(override.files).map(slashGlob),
    rules: Object.fromEntries(
      Object.entries(override.rules).map(([id, setting]) => [id, resolveRule(setting)]),
    ),
  }));

  // Paths may be written Windows-style; globs and POSIX need forward slashes. An app keeps its
  // own tsconfig over a design-system package's, which resolves the package's aliases, not its.
  const tsconfig =
    config.tsconfig === undefined ? undefined : fromBase(config.tsconfig.replaceAll('\\', '/'));
  if (tsconfig !== undefined && !fs.existsSync(path.resolve(root, tsconfig))) {
    // Without it, path aliases do not resolve and most checks go quiet.
    throw new ConfigError(
      `tsconfig not found: ${path.resolve(root, tsconfig)} (from "tsconfig" in ${configFile ?? 'the config'})`,
    );
  }

  // Without component globs, look for components.json or a design-system package.
  const componentsSet = Boolean(options.components?.length) || configComponents !== undefined;
  const detection = componentsSet
    ? undefined
    : detectProject(root, tsconfig, undefined, declared, finder(root));

  // A token file named outright (not a glob) that does not exist is a typo, not "no tokens".
  // Not in a design-system package's config, whose own checks catch it: a package installed
  // from a registry ships only some of its files.
  const explicitTokens = options.tokens?.length
    ? { paths: options.tokens, from: '--tokens' }
    : config.tokens !== undefined
      ? {
          paths: toArray(config.tokens).map((t) => fromBase(pathOf(t))),
          from: `"tokens" in ${configFile ?? 'the config'}`,
        }
      : undefined;
  for (const file of explicitTokens?.paths ?? []) {
    const absolute = path.resolve(root, slashGlob(file));
    if (!/[*?[\]{}()!]/.test(file) && !fs.existsSync(absolute)) {
      throw new ConfigError(`Token file not found: ${absolute} (from ${explicitTokens?.from})`);
    }
  }

  const components = (
    options.components?.length
      ? options.components
      : (configComponents ??
        (detection
          ? [...(detection.withDefaults ? DEFAULT_COMPONENTS : []), ...detection.components]
          : DEFAULT_COMPONENTS))
  ).map(slashGlob);

  // A design-system package whose sources these globs do not read is read from its declarations.
  const libraries = detectLibraries(root, librariesSetting, { importPath, components });

  const tokenSources: TokenSourceConfig[] = options.tokens?.length
    ? options.tokens.map((p) => ({ path: p }))
    : (configTokens ?? [
        // Detected stylesheets replace the stylesheet guesses, not DTCG files.
        ...(detection?.tokens.length
          ? [...detection.tokens, ...DEFAULT_TOKENS.filter((t) => t.endsWith('.json'))]
          : DEFAULT_TOKENS
        ).map((p) => ({ path: p })),
        ...FALLBACK_TOKENS.map((p) => ({ path: p, fallback: true })),
      ]);

  // `exclude` adds to the defaults. A pattern that starts with `!` takes out the default it
  // names (`!**/*.d.ts`), for a project that checks what the defaults leave out.
  const tidy = (e: string) =>
    slashGlob(e)
      // `./app/legacy/` is the folder `app/legacy`, also when a root config's pattern is rebased.
      .replace(/^(?:\.\/)+/, '')
      .replace(/(.)\/+$/, '$1');
  const excludeOf = (listed: readonly string[], move: (e: string) => string | undefined) => {
    const dropped = new Set(listed.filter((e) => e.startsWith('!')).map((e) => tidy(e.slice(1))));
    for (const pattern of dropped) {
      if (DEFAULT_EXCLUDE.includes(pattern)) continue;
      warnings.push(
        `"!${pattern}" in "exclude" takes out none of the defaults, which are ${DEFAULT_EXCLUDE.map((d) => `"${d}"`).join(', ')}: a pattern that starts with "!" names one of them.`,
      );
    }
    return [
      ...new Set([
        ...DEFAULT_EXCLUDE.filter((d) => !dropped.has(d)),
        ...listed.filter((e) => !e.startsWith('!')).map(tidy),
      ]),
    ]
      .map(move)
      .filter((e): e is string => e !== undefined);
  };
  const exclude = excludeOf(config.exclude ?? [], excludeFromBase);
  // A package's own list finds the package's files. The project's own files keep its defaults:
  // the package's patterns only add to them, whatever defaults it takes out.
  const packageExclude = pkg?.exclude ? excludeOf(pkg.exclude, excludeFromPackage) : undefined;

  return {
    root,
    configFile: configFile ?? declared?.config,
    components,
    exclude: packageExclude
      ? [...new Set([...exclude, ...packageExclude.filter((e) => !DEFAULT_EXCLUDE.includes(e))])]
      : exclude,
    ...(packageExclude && inherits ? { designSystemExclude: packageExclude } : {}),
    tokens: tokenSources.map((t) => ({ ...t, path: slashGlob(t.path) })),
    ...(!options.tokens?.length && configTokens === undefined ? { tokensDetected: true } : {}),
    docs: (options.docs?.length
      ? options.docs
      : (configDocs ?? [...new Set([...DEFAULT_DOCS, ...(detection?.docs ?? [])])])
    ).map(slashGlob),
    tsconfig,
    importPath,
    // Components a package's config names are imported by its exports, as detection reads them.
    imports:
      detection?.imports ??
      (declared && inherits && componentsSet ? packageImports(root, declared.dir) : []),
    detected: detection?.source,
    ...(detection?.designSystems ? { designSystems: detection.designSystems } : {}),
    tailwindConfig: findTailwindConfig(root),
    libraries: libraries.read,
    libraryIds: librariesSetting,
    librariesOff: libraries.off,
    librariesUnread: libraries.unread,
    elements: { ...(inherits ? pkg.elements : {}), ...config.elements },
    includeDesignSystem: options.includeDesignSystem ?? config.includeDesignSystem ?? false,
    rules,
    overrides,
    ...(base !== root ? { base } : {}),
    ...(declared ? { designSystemPackage: declared } : {}),
    configured: componentsSet,
    ...(deprecations.length ? { deprecations } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Whether `dir` has a config of its own: a config file under its current or old name, or one its
 * package.json names in its `onsystem` field. Without one, a project takes on its design-system
 * package's config, and, from a workspace root, the root's over it.
 */
export function hasOwnConfig(dir: string): boolean {
  if ([...CONFIG_FILES, ...LEGACY_CONFIG_FILES].some((name) => fs.existsSync(path.join(dir, name))))
    return true;
  return declaredConfig(dir) !== undefined;
}

/** The config `dir`'s own package.json names in its `onsystem` field, as a design-system package does. */
function ownDeclaredConfig(dir: string): string | undefined {
  const declared = declaredConfig(dir);
  if (declared && 'problem' in declared) throw new ConfigError(declared.problem);
  return declared?.file;
}

/** The error for workspace packages whose declaration cannot be read: their team can fix them. */
function declarationError(lookup: DesignSystemPackageLookup, dir: string): ConfigError {
  return new ConfigError(
    `${lookup.problems.map((p) => `${p.name}: ${p.problem}`).join('\n')}\nFix the "${PACKAGE_FIELD}" field in that package, or give ${dir} a config of its own (onsystem.config.json), which is read instead.`,
  );
}

/**
 * Whether a path or glob in a dependency's config, relative to its folder `dir`, stays in
 * `boundary`: its static part resolves inside it, and no `..` hides among its wildcards and
 * braces (`{src,../..}/**`), which could reach anywhere.
 */
function staysIn(dir: string, boundary: string, pattern: string): boolean {
  const base = globBase(pattern);
  const parts = pattern.split('/');
  const fixed = base === '.' ? (parts[0] === '.' ? 1 : 0) : base.split('/').length;
  if (parts.slice(fixed).some((part) => part.includes('..'))) return false;
  return isInside(boundary, path.resolve(dir, base));
}

/** What to say about a config file under its old name, with or without a new one next to it. */
function legacyConfigNotice(legacy: string, current: string | undefined): string {
  const name = path.basename(legacy);
  const renamed = name.replace(/^design-system-mcp\./, 'onsystem.');
  if (current) {
    return `${name} is ignored: ${path.basename(current)} is read instead. Delete ${name}.`;
  }
  return `${name} is the config's name from before design-system-mcp became onsystem. Rename it to ${renamed} (git mv ${name} ${renamed}); the old name still works for now.`;
}

function resolveRule(setting: z.infer<typeof ruleSettingSchema>): ResolvedRule {
  if (typeof setting === 'string') return { severity: setting, options: {} };
  return { severity: setting[0], options: setting[1] ?? {} };
}

/** The default test and story patterns, which `--include-tests` lifts. */
export function isTestPattern(pattern: string): boolean {
  return pattern === DEFAULT_TEST_EXCLUDE || pattern === DEFAULT_TEST_FOLDERS;
}

/**
 * The `exclude` pattern that leaves `file` (relative to the root) out, or undefined when none
 * does. The one test `check` (in folders and globs, and for files named outright with
 * `--skip-excluded`), the ESLint plugin, the Claude Code hook and check_ui all apply, so they
 * leave out the same files. A pattern covers the files it matches and everything in a folder it
 * matches. With `includeTests`, the default test and story patterns do not count.
 */
export function excludedBy(
  config: Pick<ResolvedConfig, 'exclude'>,
  file: string,
  options: { includeTests?: boolean } = {},
): string | undefined {
  return config.exclude.find(
    (pattern) => !(options.includeTests && isTestPattern(pattern)) && coveredByGlob(file, pattern),
  );
}

/**
 * The rules for one file: the config's `rules`, then every override whose
 * `files` match the path (relative to the root), in order.
 */
export function rulesFor(
  config: Pick<ResolvedConfig, 'rules' | 'overrides'> &
    Partial<Pick<ResolvedConfig, 'root' | 'base'>>,
  file: string | undefined,
): Record<RuleId, ResolvedRule> {
  if (!file || !config.overrides?.length) return config.rules;
  // Globs of a config at the workspace root are relative to it, not to the project.
  const fromBase =
    config.base && config.root
      ? toPosix(path.relative(config.base, path.resolve(config.root, file)))
      : file;
  const relative = toPosix(fromBase).replace(/^\.\//, '');
  let rules = config.rules;
  for (const override of config.overrides) {
    if (override.files.some((glob) => matchesGlob(relative, glob))) {
      rules = { ...rules, ...override.rules };
    }
  }
  return rules;
}

/** Whether a Node.js version runs TypeScript files without flags (type stripping): 22.18, or 23.6 and later. */
export function nodeRunsTypeScript(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

type ParsedConfig = z.output<typeof configSchema>;
type TokenSource = z.output<typeof tokenSourceSchema>;

/** A config file, read and validated: a JSON one only with `jsonConfigOnly`. */
async function readConfig(
  file: string,
  options: Pick<LoadConfigOptions, 'jsonConfigOnly'>,
): Promise<ParsedConfig> {
  if (!fs.existsSync(file)) throw new ConfigError(`Config file not found: ${file}`);
  if (options.jsonConfigOnly && !file.endsWith('.json')) {
    throw new ConfigError(
      `${file} was not run: the server runs a JavaScript or TypeScript config only in a project it was started in (its working directory, --root or the client's roots), not in one found from the path a tool call names. Start the server in the project, or use onsystem.config.json.`,
    );
  }
  const parsed = configSchema.safeParse(await readConfigFile(file));
  if (!parsed.success) {
    throw new ConfigError(`Invalid config in ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function readConfigFile(file: string): Promise<unknown> {
  if (/\.[cm]?ts$/.test(file) && !nodeRunsTypeScript()) {
    throw new ConfigError(
      `${file} is TypeScript, which Node.js runs from 22.18; this is ${process.version}. Use onsystem.config.json or .mjs, or Node.js 22.18 or later.`,
    );
  }
  if (file.endsWith('.json')) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    } catch (error) {
      throw new ConfigError(`Could not parse ${file}: ${(error as Error).message}`);
    }
  }
  try {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    return mod.default ?? mod;
  } catch (error) {
    const message = (error as Error).message;
    // A config that imports defineConfig from the package's old name, which is no longer installed.
    const hint = message.includes('@dgesteves/design-system-mcp')
      ? " The package is now onsystem: import { defineConfig } from 'onsystem'."
      : /\.m?ts$/.test(file)
        ? ' TypeScript configs need Node.js 22.18+ (type stripping); use JSON or .mjs otherwise.'
        : '';
    throw new ConfigError(`Could not load ${file}: ${message}.${hint}`);
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/** JSON Schema for editor completion in `onsystem.config.json`. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(configSchema, { target: 'draft-7', io: 'input' });
}
