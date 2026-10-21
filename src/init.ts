import fs from 'node:fs';
import path from 'node:path';

import { escapePath } from 'tinyglobby';

import { BASELINE_FILE, LEGACY_BASELINE_FILE } from './baseline.js';
import {
  CONFIG_FILES,
  DEFAULT_DOCS,
  LEGACY_CONFIG_FILES,
  type LoadConfigOptions,
  type ResolvedConfig,
} from './config.js';
import {
  componentFiles,
  loadDesignSystem,
  tokenFiles,
  type DesignSystem,
} from './design-system.js';
import {
  declaredConfig,
  type DesignSystemPackage,
  isDesignSystemName,
  PACKAGE_FIELD,
} from './detect.js';
import { readProjectConfig, type ProjectConfig } from './extract/program.js';
import { statusKinds, type StatusKind } from './tokens/roles.js';
import { isInside, matchesGlob, relativePath } from './util/paths.js';
import { NAME } from './version.js';
import { loadTarget } from './workspace.js';

/** What `init` needs from the CLI it runs in. */
export interface InitIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Asks a question and resolves to the answer; undefined when there is no terminal to ask in. */
  prompt?: ((question: string) => Promise<string>) | undefined;
}

export interface InitOptions {
  yes: boolean;
  force: boolean;
  cache: boolean;
}

/** Runs `check` the way the CLI does, with its output captured. */
export type RunCheck = (
  args: string[],
  io: InitIo,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const SCHEMA = 'https://unpkg.com/onsystem/schema.json';
/** More detected globs than this are files, not folders: zero config keeps them. */
const MAX_GLOBS = 6;

/** What a design-system package's apps are told about it, next to its config. */
export const GUIDE_FILE = 'ONSYSTEM.md';

/**
 * Writes `onsystem.config.json` in the root from what zero config finds there, or from
 * the answers to up to three questions when it finds nothing, then checks the project
 * once without failing and offers to record what it found as the baseline.
 *
 * In a design-system package (one zero config reads through its own `exports`, or named like
 * one, as apps look for it), it also declares the config in package.json
 * (`"onsystem": "./onsystem.config.json"`, and in `files` when the package lists them), so
 * every app that depends on the package reads it, and writes ONSYSTEM.md, which tells those
 * apps' teams how to add the agent tools and the CI check. In an app that takes on such a
 * package's config, it writes no config of its own unless --force says to, and then one that
 * builds on the package's, for the app's own rules and overrides.
 *
 * In a terminal, it offers to add a short section on onsystem to the project's AGENTS.md or
 * CLAUDE.md, for coding agents.
 */
export async function init(
  configOptions: LoadConfigOptions,
  options: InitOptions,
  io: InitIo,
  runCheck: RunCheck,
): Promise<number> {
  const target = await loadTarget({ ...configOptions, config: undefined });
  const { config, workspace } = target;
  const root = config.root;
  const declared = declaredConfig(root);
  const existing =
    [...CONFIG_FILES, ...LEGACY_CONFIG_FILES]
      .map((name) => path.join(root, name))
      .find((file) => fs.existsSync(file)) ??
    (declared && 'file' in declared ? declared.file : undefined);
  const manifest = readManifest(root);
  const name = typeof manifest?.json.name === 'string' ? manifest.json.name : undefined;
  // A package apps depend on for its components: what zero config reads in it through its
  // exports, or a name like the ones apps' zero config looks for.
  const designSystem =
    !workspace &&
    !config.designSystemPackage &&
    name !== undefined &&
    (config.detected?.startsWith('package.json exports of') === true || isDesignSystemName(name));
  if (existing && !options.force) {
    // --force would replace a design-system package's config; declaring it keeps it.
    const share =
      designSystem && !declared && existing.endsWith('.json')
        ? ` To share it with the apps that depend on ${name}, add "${PACKAGE_FIELD}": "./${path.basename(existing)}" to package.json, and to "files" when it lists them (https://onsystem.vercel.app/docs/design-system-packages).`
        : '';
    io.stderr(
      `init: ${relativePath(io.cwd, existing) || existing} already exists. Run \`${NAME} inspect --explain\` to see what it resolves to, or pass --force to write a new onsystem.config.json.${share}`,
    );
    return 2;
  }
  const ask = options.yes ? undefined : io.prompt;

  const file: Record<string, unknown> = { $schema: SCHEMA };
  const notes: string[] = [];
  const relative = (abs: string) => relativePath(root, abs);
  // An app on a design-system package that declares its config needs none of its own.
  const inherited = options.force ? undefined : config.designSystemPackage;
  // With --force, the config written here builds on the package's.
  const replaced = options.force ? config.designSystemPackage : undefined;
  // "components" holds what zero config found, not globs the user gave.
  let found = false;
  if (inherited) {
    notes.push(
      `This project takes on the config ${inherited.name} declares in its package.json (${relativePath(io.cwd, inherited.config) || inherited.config}), so it needs none of its own; nothing was written. Pass --force to write one for its own rules and overrides, which builds on ${inherited.name}'s.`,
    );
  } else if (configOptions.components?.length) {
    file.components = configOptions.components;
    if (configOptions.tokens?.length) file.tokens = configOptions.tokens;
    if (configOptions.docs?.length) file.docs = configOptions.docs;
  } else if (replaced) {
    // What the config leaves out comes from the package's, as it does with none: it holds only
    // the app's own rules and overrides, once they are added.
  } else if (workspace) {
    // At a monorepo root, each project keeps zero config; the file holds what they share.
    notes.push(
      `This is a monorepo root: ${workspace.projects.length} of ${workspace.projects.length + workspace.others.length} workspace packages have a design system (${workspace.projects.map((p) => p.dir).join(', ') || 'none'}). Each keeps zero config; rules and overrides you add here apply to every project without a config of its own when it is checked from this folder, over the config its design-system package declares.`,
    );
  } else if (config.detected) {
    notes.push(`Found the design system through ${config.detected}.`);
    const specifiers = new Set((config.imports ?? []).map((m) => m.specifier));
    const tokens = (await tokenFiles(config)).map(relative);
    const fromInstalled = installedFields(config.components, tokens);
    if (fromInstalled.length) notes.push(installedNote(fromInstalled));
    if (fromInstalled.includes('components')) {
      // Spelled out, they would miss the package's next version.
    } else if (specifiers.size > 1) {
      notes.push(
        `"components" is left to zero config: apps import them by ${specifiers.size} specifiers from the package's exports (${[...specifiers].slice(0, 2).join(', ')}, …), which a config cannot spell.`,
      );
    } else if (config.components.length > MAX_GLOBS) {
      notes.push(
        `"components" is left to zero config: it found ${config.components.length} files through the package's exports, which it keeps following as the package changes.`,
      );
    } else {
      // The detected globs, spelled out; a package imported by one name keeps it. A pattern
      // (`@acme/ui/components/*`) is no import: zero config keeps giving each file its own.
      file.components = config.components;
      found = true;
      const [specifier] = specifiers;
      if (specifier && !specifier.includes('*')) file.importPath = specifier;
      // Docs found next to the detected components stay found.
      const docs = config.docs.filter((d) => !DEFAULT_DOCS.includes(d));
      if (docs.length) file.docs = [...DEFAULT_DOCS, ...docs];
    }
    if (tokens.length && !fromInstalled.includes('tokens')) file.tokens = tokens;
  } else if ((await componentFiles(config)).length) {
    // Nothing detected, but the default folders hold components (`components/ui` without a
    // components.json), as `check` and `inspect` find them: spell out the ones that match.
    const matching: string[] = [];
    for (const glob of config.components) {
      if ((await componentFiles({ ...config, components: [glob] })).length) matching.push(glob);
    }
    notes.push(`Found the design system in the default folders: ${matching.join(', ')}.`);
    file.components = matching;
    found = true;
    const tokens = (await tokenFiles(config)).map(relative);
    const fromInstalled = installedFields([], tokens);
    if (fromInstalled.length) notes.push(installedNote(fromInstalled));
    else if (tokens.length) file.tokens = tokens;
  } else {
    if (!ask) {
      io.stderr(
        `init: zero config found no design system in ${root}. Pass --components (and --tokens) to say where it is, or run init in a terminal to answer a few questions. \`${NAME} inspect --explain\` shows what it looked at.`,
      );
      return 2;
    }
    io.stdout(`Zero config found no design system in ${root}.`);
    let components = '';
    for (let attempt = 0; attempt < 3 && !components; attempt++) {
      const answer = (
        await ask(
          'Where are the components? A glob from the root, e.g. src/components/ui/**/*.tsx: ',
        )
      ).trim();
      if (!answer) continue;
      const matches = await componentFiles({ ...config, components: [answer] });
      if (matches.length) components = answer;
      else io.stdout(`No file matches ${answer}.`);
    }
    if (!components) {
      io.stderr('init: no components given; nothing written.');
      return 2;
    }
    file.components = [components];
    const tokens = (
      await ask('Where are the tokens? A CSS or DTCG .json file, or leave it empty: ')
    ).trim();
    if (tokens) {
      if (!fs.existsSync(path.resolve(root, tokens)) && !/[*?{]/.test(tokens)) {
        io.stdout(`${tokens} does not exist; it is left out.`);
      } else file.tokens = [tokens];
    }
    const importPath = (
      await ask(
        'How do apps import them? A package name such as @acme/ui, or leave it empty for tsconfig paths: ',
      )
    ).trim();
    if (importPath) file.importPath = importPath;
  }
  if (!inherited && !workspace) notes.push(...(await registryCode(config, file, found)));

  const written: string[] = [];
  if (!inherited) {
    const out = path.join(root, CONFIG_FILE);
    fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
    written.push(CONFIG_FILE);
  }
  if (replaced) notes.push(replacedNote(replaced, io.cwd));
  let registry: Unshipped | undefined;
  if (designSystem && manifest && name) {
    written.push(...declarePackage(root, manifest, name, options.force, notes));
    registry = await unshipped(config, manifest.json);
    if (registry) notes.push(...registry.notes);
  }
  for (const note of notes) io.stdout(note);
  if (written.length) {
    io.stdout(
      `Wrote ${written.map((f) => relativePath(io.cwd, path.join(root, f)) || f).join(', ')}.`,
    );
  }

  // A dry run: what `check .` reports with this config, by rule, without failing.
  const checkIo = { ...io, cwd: root };
  const dry = await runCheck(
    ['check', '.', '--format', 'json', ...(options.cache ? [] : ['--no-cache'])],
    checkIo,
  );
  let results: { diagnostics: { ruleId: string; severity: string }[] }[] = [];
  try {
    results = JSON.parse(dry.stdout || '[]') as typeof results;
  } catch {
    io.stderr(`init: the dry run did not finish: ${dry.stderr.split('\n')[0] ?? ''}`);
    return 1;
  }
  const byRule = new Map<string, number>();
  let errors = 0;
  let warnings = 0;
  for (const result of results) {
    for (const d of result.diagnostics) {
      byRule.set(d.ruleId, (byRule.get(d.ruleId) ?? 0) + 1);
      if (d.severity === 'error') errors++;
      else warnings++;
    }
  }
  const flagged = results.filter((r) => r.diagnostics.length).length;
  const total = errors + warnings;
  io.stdout(
    total
      ? `Dry run of \`${NAME} check .\`: ${count(errors, 'error')} and ${count(warnings, 'warning')} in ${flagged} of ${count(results.length, 'file')}. By rule: ${[
          ...byRule,
        ]
          .sort((a, b) => b[1] - a[1])
          .map(([rule, n]) => `${rule} ${n.toLocaleString('en-US')}`)
          .join(', ')}.`
      : `Dry run of \`${NAME} check .\`: no problems in ${count(results.length, 'file')}.`,
  );
  for (const line of dry.stderr.split('\n').filter(Boolean)) io.stdout(line);
  if (!workspace) {
    const own = (await loadTarget({ ...configOptions, config: undefined })).config;
    const note = statusNote(await loadDesignSystem(own, { cache: options.cache }));
    if (note) io.stdout(note);
  }

  // An existing codebase starts with findings: record them, so CI fails only on new ones.
  const hasBaseline = [BASELINE_FILE, LEGACY_BASELINE_FILE].some((name) =>
    fs.existsSync(path.join(root, name)),
  );
  let baselineWritten = false;
  if (total && !hasBaseline) {
    const answer = options.yes
      ? 'y'
      : ask
        ? (
            await ask(
              `Record these ${total.toLocaleString('en-US')} findings in ${BASELINE_FILE}, so check fails only on new ones? [Y/n] `,
            )
          )
            .trim()
            .toLowerCase()
        : undefined;
    if (answer === undefined) {
      io.stdout(
        `No terminal to ask in, so the baseline question was skipped and no baseline was written; \`${NAME} check . --update-baseline\` records one.`,
      );
    } else if (answer === '' || answer.startsWith('y')) {
      const recorded = await runCheck(
        ['check', '.', '--update-baseline', ...(options.cache ? [] : ['--no-cache'])],
        checkIo,
      );
      if (recorded.stdout) io.stdout(recorded.stdout);
      baselineWritten = fs.existsSync(path.join(root, BASELINE_FILE));
    } else {
      io.stdout(`No baseline written; \`${NAME} check . --update-baseline\` records one later.`);
    }
  }
  const instructed = await agentRules(root, ask, io);
  const commit = [...written, ...(baselineWritten ? [BASELINE_FILE] : []), ...instructed];
  const files =
    commit.length > 1 ? `${commit.slice(0, -1).join(', ')} and ${commit.at(-1) ?? ''}` : commit[0];
  io.stdout(
    designSystem && name
      ? registry
        ? `Next: commit ${files}. A workspace app that depends on ${name} now finds it with no config of its own: run \`npx ${NAME} inspect\` in one to see it, and give its team ${GUIDE_FILE}. An app that installs ${name} from a registry ${registry.next}.`
        : `Next: commit ${files}. An app that depends on ${name} now finds it with no config of its own: run \`npx ${NAME} inspect\` in one to see it, and give its team ${GUIDE_FILE}.`
      : `Next: ${files ? `commit ${files}, and ` : ''}run \`npx ${NAME} check . --format github --require-design-system\` in CI.`,
  );
  return 0;
}

const CONFIG_FILE = 'onsystem.config.json';

/** The status colors docs/tokens.md#status-colors adds, and the hue each one is. */
const RECIPE: [StatusKind, string][] = [
  ['success', 'green'],
  ['warning', 'yellow'],
  ['info', 'blue'],
];

/**
 * Says which of success, warning and info the theme has no color for, and where the CSS that adds
 * them is: without one, an agent asked for a green "Active" label tends to reach for a chart or a
 * gray token, which loses what the color says. Nothing when the theme has no colors, or all three.
 */
function statusNote(ds: DesignSystem): string | undefined {
  if (!ds.tokens.some((token) => token.category === 'color')) return undefined;
  const has = statusKinds(ds.tokens);
  const missing = RECIPE.filter(([kind]) => !has.has(kind));
  if (!missing.length) return undefined;
  const kinds = orList(missing.map(([kind]) => kind));
  const hues = orList(missing.map(([, hue]) => hue));
  return `The theme has no ${kinds} token, so a ${hues} status color has no token to use, and agents tend to reach for a chart or gray token instead. To add ${missing.length === 1 ? 'it' : 'them'}: https://onsystem.vercel.app/docs/tokens#status-colors.`;
}

/** `success, warning or info`. */
function orList(items: string[]): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`
    : (items[0] ?? '');
}

/** The instruction files agents read, which `init` offers to add onsystem's section to. */
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'];
const RULES_BEGIN = '<!-- BEGIN:onsystem-agent-rules -->';
const RULES_END = '<!-- END:onsystem-agent-rules -->';
/** onsystem's section of AGENTS.md or CLAUDE.md: the MCP tools, and the CLI for agents without them. */
const AGENT_RULES = [
  RULES_BEGIN,
  '# Design system',
  '',
  `This project's UI is checked against its design system by ${NAME}.`,
  '',
  `- Before writing UI, look up its components, props, variants and tokens with the ${NAME} tools (\`list_components\`, \`get_component\`, \`get_tokens\`).`,
  `- After changing a \`.tsx\` or \`.jsx\` file, run \`check_ui\` on it and fix every error. Without the ${NAME} tools, run \`npx -y ${NAME} check <file>\` instead.`,
  RULES_END,
].join('\n');

/**
 * Offers to add onsystem's section to the AGENTS.md and CLAUDE.md in the root, between markers a
 * later run updates in place, so agents that read them check the UI they write, through the CLI
 * when they have no MCP config. A CLAUDE.md that imports AGENTS.md (an `@AGENTS.md` line) is left
 * alone: Claude Code reads the section there. Asked only in a terminal, never with --yes; nothing
 * is asked when neither file exists or the section is current. Returns the files it wrote.
 */
async function agentRules(root: string, ask: InitIo['prompt'], io: InitIo): Promise<string[]> {
  if (!ask) return [];
  const found = AGENT_FILES.flatMap((name) => {
    const file = path.join(root, name);
    try {
      return [{ name, file, text: fs.readFileSync(file, 'utf8') }];
    } catch {
      return [];
    }
  });
  const imports = (text: string) => /^\s*@(?:\.\/)?AGENTS\.md\s*$/m.test(text);
  const changes = found
    .filter((f) => !(f.name === 'CLAUDE.md' && imports(f.text) && found.length > 1))
    .map((f) => ({ ...f, next: withAgentRules(f.text) }))
    .filter((f) => f.next !== f.text);
  if (!changes.length) return [];
  const names = andList(changes.map((f) => f.name));
  const update = changes.every((f) => rulesSection(f.text) !== undefined);
  const answer = (
    await ask(
      update
        ? `Update the onsystem section in ${names}? [Y/n] `
        : `Add a short onsystem section to ${names}, so coding agents check the UI they write? [Y/n] `,
    )
  )
    .trim()
    .toLowerCase();
  if (answer !== '' && !answer.startsWith('y')) {
    io.stdout(
      `${names} ${changes.length === 1 ? 'was' : 'were'} left as ${changes.length === 1 ? 'it is' : 'they are'}.`,
    );
    return [];
  }
  for (const f of changes) fs.writeFileSync(f.file, f.next);
  io.stdout(
    update
      ? `Updated the onsystem section in ${names}.`
      : `Added an onsystem section to ${names}: it tells agents to run check_ui, or \`npx -y ${NAME} check <file>\` without the ${NAME} tools, on the UI files they change.`,
  );
  return changes.map((f) => f.name);
}

/** `text` with onsystem's section: replaced between its markers, or added at the end. */
function withAgentRules(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rules = AGENT_RULES.replaceAll('\n', eol);
  const found = rulesSection(text);
  if (found) return `${text.slice(0, found.start)}${rules}${text.slice(found.end)}`;
  if (!text.trim()) return `${rules}${eol}`;
  return `${text.endsWith('\n') ? text : `${text}${eol}`}${eol}${rules}${eol}`;
}

/**
 * Where onsystem's section is in `text`, from its BEGIN marker to the end of its END marker: the
 * first END with a BEGIN before it, and the BEGIN nearest that END. A BEGIN whose END was deleted
 * is then not a section, so the text after it, which may be the user's, is never replaced.
 */
function rulesSection(text: string): { start: number; end: number } | undefined {
  for (let end = text.indexOf(RULES_END); end !== -1; end = text.indexOf(RULES_END, end + 1)) {
    const start = text.lastIndexOf(RULES_BEGIN, end);
    if (start !== -1) return { start, end: end + RULES_END.length };
  }
  return undefined;
}

/** A package.json as read, with the indentation to write it back in. */
interface Manifest {
  file: string;
  json: Record<string, unknown>;
  indent: string;
  newline: boolean;
}

function readManifest(root: string): Manifest | undefined {
  const file = path.join(root, 'package.json');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
    return {
      file,
      json: json as Record<string, unknown>,
      indent: /^([ \t]+)"/m.exec(text)?.[1] ?? '  ',
      newline: text.endsWith('\n'),
    };
  } catch {
    return undefined;
  }
}

/**
 * Declares the config in the package's package.json, `"onsystem": "./onsystem.config.json"`,
 * and adds it to `files` when the package lists the files it publishes, so apps that install it
 * get it too. Writes ONSYSTEM.md for the apps' teams unless one exists. Returns what it wrote.
 */
function declarePackage(
  root: string,
  manifest: Manifest,
  name: string,
  force: boolean,
  notes: string[],
): string[] {
  const written: string[] = [];
  const { json } = manifest;
  const value = `./${CONFIG_FILE}`;
  let changed = false;
  if (json[PACKAGE_FIELD] !== value) {
    json[PACKAGE_FIELD] = value;
    changed = true;
  }
  const files = Array.isArray(json.files) ? (json.files as unknown[]) : undefined;
  if (files && !ships(files, CONFIG_FILE)) {
    files.push(CONFIG_FILE);
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(
      manifest.file,
      `${JSON.stringify(json, null, manifest.indent)}${manifest.newline ? '\n' : ''}`,
    );
    written.push('package.json');
  }
  notes.push(
    `This is a design-system package: package.json declares its config ("${PACKAGE_FIELD}": "${value}"${files ? ', also added to "files"' : ''}), which every app that depends on ${name} reads when it has no config of its own.`,
  );
  const guide = path.join(root, GUIDE_FILE);
  if (force || !fs.existsSync(guide)) {
    fs.writeFileSync(guide, consumerGuide(name));
    written.push(GUIDE_FILE);
  } else {
    notes.push(`${GUIDE_FILE} already exists; it was left as it is (--force replaces it).`);
  }
  return written;
}

/** What apps that install a design-system package from a registry miss, for its team. */
interface Unshipped {
  notes: string[];
  /** Ends the next steps: `An app that installs @acme/ui from a registry …`. */
  next: string;
}

/**
 * What apps that install the package from a registry will not find: the component and token
 * files its `files` list leaves out of the published package, and those outside the package
 * (`../tailwind-config/theme.css`), which an installed package's config cannot reach. Undefined
 * for a private package, or when they find every file. Without a `files` list, npm publishes
 * everything in the package. Without any component file, those apps read the components from
 * the type declarations the package publishes, when it names some.
 */
async function unshipped(
  config: ResolvedConfig,
  json: Record<string, unknown>,
): Promise<Unshipped | undefined> {
  if (json.private === true) return undefined;
  const name = typeof json.name === 'string' ? json.name : 'the package';
  const files = Array.isArray(json.files) ? (json.files as unknown[]) : undefined;
  const relative = (abs: string[]) => abs.map((f) => relativePath(config.root, f));
  const components = relative(await componentFiles(config));
  const tokens = relative(await tokenFiles(config));
  const outside = (f: string) => f.startsWith('../');
  const left = (list: string[]) =>
    files ? list.filter((f) => !outside(f) && !ships(files, f)) : [];
  const missing = { components: left(components), tokens: left(tokens) };
  const away = { components: components.filter(outside), tokens: tokens.filter(outside) };
  // With every component file left out, those apps read the components from the package's type
  // declarations, or, when it publishes none, know no component.
  const noComponents =
    components.length > 0 &&
    missing.components.length + away.components.length === components.length;
  const declarations = noComponents ? publishedDeclarations(config.root, json, files) : [];
  // `(3 component files and 1 token file). Those apps do not know the components or tokens in it…`
  const lost = (lists: { components: string[]; tokens: string[] }, one: boolean) => {
    const c = lists.components.length;
    const t = lists.tokens.length;
    const kinds = andList([
      ...(c ? [count(c, 'component file')] : []),
      ...(t ? [count(t, 'token file')] : []),
    ]);
    const them = one ? 'it' : 'them';
    if (c && noComponents && declarations.length) {
      return `(${kinds}). Those apps read the components from the type declarations it publishes instead (${andList(declarations)})${t ? `, and do not know the tokens in ${them}` : ''}.`;
    }
    const what = andList([...(c ? ['components'] : []), ...(t ? ['tokens'] : [])], 'or');
    const checks =
      c && noComponents
        ? `: with no type declarations published either, they get no component, prop, variant or native-element checks, and \`${NAME} check --require-design-system\` fails in them`
        : '';
    return `(${kinds}). Those apps do not know the ${what} in ${them}${checks}.`;
  };

  const notes: string[] = [];
  const top = (f: string) => (f.includes('/') ? `${f.slice(0, f.indexOf('/'))}/` : f);
  const folders = [...new Set([...missing.components, ...missing.tokens].map(top))];
  if (folders.length) {
    const one = folders.length === 1;
    notes.push(
      `Apps that install ${name} from a registry get only what "files" in package.json publishes, which leaves out ${andList(folders)} ${lost(missing, one)} Add ${one ? 'it' : 'them'} to "files" for them; workspace apps read the sources either way.`,
    );
  }
  const beyond = [...away.components, ...away.tokens];
  if (beyond.length) {
    const one = beyond.length === 1;
    notes.push(
      `Apps that install ${name} from a registry read only the files in it, so they skip ${andList(beyond)}, outside the package ${lost(away, one)} Workspace apps read ${one ? 'it' : 'them'}. To give installed apps what ${one ? 'it holds' : 'they hold'}, keep a copy in the package, publish it, and name the copy in the config instead.`,
    );
  }
  if (!notes.length) return undefined;
  return {
    notes,
    next:
      noComponents && missing.components.length
        ? declarations.length
          ? `reads its components from the type declarations it publishes, not from ${andList([...new Set(missing.components.map(top))])}`
          : `gets no component checks until "files" publishes ${andList([...new Set(missing.components.map(top))])}`
        : `does not read ${andList([...folders, ...beyond])}`,
  };
}

/**
 * The type declarations a package's package.json names, as apps that install it look for them:
 * `types` or `typings`, a `types` condition in its `exports`, or an `index.d.ts` beside it, each
 * that its `files` list publishes. Relative to the package.
 */
function publishedDeclarations(
  root: string,
  json: Record<string, unknown>,
  files: readonly unknown[] | undefined,
): string[] {
  const named: string[] = [];
  for (const field of ['types', 'typings']) {
    const value = json[field];
    if (typeof value === 'string') named.push(value);
  }
  const conditions = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key === 'types') named.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) conditions(item);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) conditions(v, k);
    }
  };
  conditions(json.exports);
  if (fs.existsSync(path.join(root, 'index.d.ts'))) named.push('index.d.ts');
  return [...new Set(named.map((f) => f.replace(/^\.\//, '')))].filter(
    (f) => !files || ships(files, f),
  );
}

/**
 * Said when --force writes a config in an app on a design-system package that declares one: the
 * new config builds on the package's, which still gives it what it leaves out.
 */
function replacedNote(pkg: DesignSystemPackage, cwd: string): string {
  const declared = relativePath(cwd, pkg.config) || pkg.config;
  return `This project reads the config ${pkg.name} declares (${declared}). With --force it has one of its own, ${CONFIG_FILE}, read over that one: what it leaves out, such as "components", "importPath" and "tokens", still comes from ${pkg.name}'s config, and the rules and overrides you add to it apply over ${pkg.name}'s rules. "extends": false in it reads it alone.`;
}

/** Whether a path, relative to the root, is in a package installed in `node_modules`. */
const isInstalledPath = (file: string) => /(?:^|\/)node_modules\//.test(file);

/**
 * The fields `init` leaves to zero config because what zero config found for them is in a
 * package installed in `node_modules`: `components` (their globs) and `tokens` (files).
 */
function installedFields(
  components: readonly string[],
  tokens: readonly string[],
): ('components' | 'tokens')[] {
  return [
    ...(components.some(isInstalledPath) ? ['components' as const] : []),
    ...(tokens.some(isInstalledPath) ? ['tokens' as const] : []),
  ];
}

/**
 * Why `fields` are left to zero config: a path into an installed package breaks when it is
 * upgraded, since pnpm keeps each version in a folder of its own
 * (`node_modules/.pnpm/@acme+ui@1.2.0_react@19.2.0/node_modules/@acme/ui`), and a list of its
 * files misses the ones a new version adds. Zero config finds it again each time.
 */
function installedNote(fields: readonly string[]): string {
  const one = fields.length === 1;
  return `${andList(fields.map((f) => `"${f}"`))} ${one ? 'is' : 'are'} left to zero config: ${one ? 'it comes' : 'they come'} from a package installed in node_modules, which zero config finds again after each upgrade, while a path written here would break once the package's folder or files change (pnpm keeps each version in a folder of its own in node_modules/.pnpm).`;
}

const REGISTRY_DOCS = 'https://onsystem.vercel.app/docs/configuration#code-from-shadcn-registries';

/**
 * Sets apart the code `npx shadcn add` copies from the registries components.json names
 * (`"registries": { "@signoff-ui": … }`) into a folder of its own under the components alias
 * (`components/signoff-ui`). When `found` says "components" holds what zero config found, and
 * no `importPath` names a package for them, each such folder joins it: `check` and the hook skip
 * that code, as they skip components/ui, and the app's code is checked against its components.
 * A folder with no .tsx or .jsx file yet joins it too, and so does one that does not exist yet:
 * a registry is often named in components.json before its first `shadcn add`, and an item of
 * only .ts files (signoff-ui's ag-ui) makes the folder before a component comes. Otherwise the
 * notes name the folders `check` reads as the app's own code, and what to add to set them apart.
 * Folders the components already take in are left alone. Returns what to tell the user.
 */
async function registryCode(
  config: ResolvedConfig,
  file: Record<string, unknown>,
  found: boolean,
): Promise<string[]> {
  const root = config.root;
  const folders = registryFolders(root, config.tsconfig);
  if (!folders.length) return [];
  const globs = Array.isArray(file.components) ? (file.components as string[]) : config.components;
  const taken = new Set(await componentFiles({ ...config, components: globs }));
  // copied: holds .tsx or .jsx files the components don't take. pending: holds none yet, or is
  // not there yet; the next `shadcn add` from that registry fills it.
  const copied: RegistryFolder[] = [];
  const pending: RegistryFolder[] = [];
  const added: string[] = [];
  for (const { namespace, dir } of folders) {
    const glob = `${escapePath(dir)}/**/*.{tsx,jsx}`;
    const files = await componentFiles({ ...config, components: [glob] });
    const folder = { namespace, dir, glob, files: files.length };
    if (files.some((f) => !taken.has(f))) copied.push(folder);
    else if (files.length || globs.some((g) => matchesGlob(`${dir}/index.tsx`, g))) continue;
    else pending.push(folder);
    added.push(glob);
  }
  const add = found && file.importPath === undefined;
  if (add && added.length) file.components = [...globs, ...added];
  // What sets folders apart by hand: their globs in "components", when the config lists them
  // and no package name would mislabel them, or else an "overrides" entry for their files.
  const listed = Array.isArray(file.components) && file.importPath === undefined;
  const how = (list: RegistryFolder[]) =>
    listed
      ? `add ${andList(list.map((f) => `"${f.glob}"`))} to "components" (${REGISTRY_DOCS})`
      : `turn the rules off for ${andList(list.map((f) => `"${escapePath(f.dir)}/**"`))} in "overrides" (${REGISTRY_DOCS})`;
  const notes: string[] = [];
  if (copied.length) {
    const one = copied.length === 1;
    notes.push(
      add
        ? `Added ${andList(copied.map((f) => `${f.dir} (${f.namespace}, ${count(f.files, 'file')})`))} to "components": ${one ? 'it holds' : 'they hold'} the code \`shadcn add\` copied from ${one ? 'that registry' : 'those registries'} in components.json. \`check\` and the hook skip it as design-system code, and your code is checked against every component its files export, helpers included, so a native element such as <img> can be told to use one of them. To leave the helpers out, see ${REGISTRY_DOCS}; to check that code as your own, take ${one ? 'the folder' : 'the folders'} out of "components".`
        : `components.json names the ${one ? 'registry' : 'registries'} ${andList(copied.map((f) => f.namespace))}, which \`shadcn add\` copies into ${andList(copied.map((f) => f.dir))}: \`check\` reads ${one ? 'its' : 'their'} code as your own. To set it apart, ${how(copied)}.`,
    );
  }
  if (pending.length) {
    const one = pending.length === 1;
    // A folder that is not there holds no .tsx or .jsx file either.
    const state = pending.some((f) => isDirectory(path.join(root, f.dir)))
      ? `${one ? 'holds' : 'hold'} no .tsx or .jsx file yet`
      : `${one ? 'does' : 'do'} not exist yet`;
    notes.push(
      add
        ? `${copied.length ? 'Also added' : 'Added'} ${andList(pending.map((f) => `${f.dir} (${f.namespace})`))} to "components", though ${one ? 'it' : 'they'} ${state}: \`check\` and the hook skip the code \`shadcn add\` copies there from ${one ? 'that registry' : 'those registries'} in components.json. Code a registry copies somewhere else, such as loose into ${path.posix.dirname(pending[0]?.dir ?? '')}/, is checked as your own (${REGISTRY_DOCS}).`
        : `components.json ${copied.length ? 'also ' : ''}names ${andList(pending.map((f) => f.namespace))}, and ${andList(pending.map((f) => f.dir))} ${state}: once \`shadcn add\` copies a .tsx or .jsx file there, \`check\` reads it as your own. To set it apart, ${how(pending)}.`,
    );
  }
  return notes;
}

interface RegistryFolder {
  namespace: string;
  dir: string;
  glob: string;
  files: number;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folders, relative to the root, that `npx shadcn add` copies the code of the registries
 * components.json names into: the components alias, resolved through tsconfig `paths`, and the
 * namespace without its `@` (`@/components` and `@signoff-ui` → `components/signoff-ui`).
 */
function registryFolders(
  root: string,
  tsconfig: string | undefined,
): { namespace: string; dir: string }[] {
  let json: { registries?: unknown; aliases?: { components?: unknown } } | undefined;
  try {
    json = JSON.parse(fs.readFileSync(path.join(root, 'components.json'), 'utf8')) as typeof json;
  } catch {
    return [];
  }
  const alias = json?.aliases?.components;
  const registries = json?.registries;
  if (typeof alias !== 'string' || !registries || typeof registries !== 'object') return [];
  // Namespaces as shadcn spells them, `@` and a name, so none leads out of the folder.
  const namespaces = Object.keys(registries)
    .filter((n) => /^@[a-z0-9][\w-]*$/i.test(n))
    .sort();
  const base = namespaces.length
    ? aliasFolder(alias, readProjectConfig(root, tsconfig))
    : undefined;
  if (!base || !isInside(root, base)) return [];
  return namespaces.map((namespace) => ({
    namespace,
    dir: relativePath(root, path.join(base, namespace.slice(1))),
  }));
}

/**
 * A components.json alias (`@/components`) through tsconfig `paths` (`"@/*": ["./*"]`), as zero
 * config resolves the ui alias, when the folder exists.
 */
function aliasFolder(alias: string, project: ProjectConfig): string | undefined {
  for (const [pattern, targets] of Object.entries(project.paths)) {
    const star = pattern.indexOf('*');
    const prefix = star === -1 ? pattern : pattern.slice(0, star);
    const suffix = star === -1 ? '' : pattern.slice(star + 1);
    const matches =
      star === -1
        ? alias === pattern
        : alias.startsWith(prefix) &&
          alias.endsWith(suffix) &&
          alias.length >= prefix.length + suffix.length;
    if (!matches) continue;
    const middle = star === -1 ? '' : alias.slice(prefix.length, alias.length - suffix.length);
    for (const target of targets) {
      const dir = path.resolve(project.pathsBase, target.replace('*', middle));
      try {
        if (fs.statSync(dir).isDirectory()) return dir;
      } catch {
        // Not there: the next target.
      }
    }
  }
  return undefined;
}

/** Whether npm's `files` list publishes `file`, a path relative to the package. */
function ships(files: readonly unknown[], file: string): boolean {
  return files.some((entry) => {
    if (typeof entry !== 'string') return false;
    const pattern = entry.replace(/^\.?\//, '').replace(/\/+$/, '');
    if (!pattern || pattern.startsWith('!')) return false;
    return (
      file === pattern ||
      file.startsWith(`${pattern}/`) ||
      matchesGlob(file, pattern) ||
      matchesGlob(file, `${pattern}/**`)
    );
  });
}

/** ONSYSTEM.md: how an app that uses the package gets the design system to its agents and CI. */
function consumerGuide(name: string): string {
  return `${[
    `# onsystem in apps that use ${name}`,
    '',
    `${name} declares its [onsystem](https://onsystem.vercel.app) config in its package.json: \`"${PACKAGE_FIELD}": "./${CONFIG_FILE}"\`. An app that depends on ${name}, as a workspace package or installed from npm, reads that config when it has none of its own, and its UI is checked against ${name}'s components, props, variants and tokens. To see what an app finds, run this in its folder:`,
    '',
    '```sh',
    `npx -y ${NAME} inspect`,
    '```',
    '',
    `An app with an ${CONFIG_FILE} of its own reads it over ${name}'s config: what it leaves out, such as the components, \`importPath\` and tokens, comes from ${name}'s, and the rules and overrides it sets apply over ${name}'s rules. \`"extends": false\` in it reads it alone.`,
    '',
    '## Coding agents',
    '',
    'Claude Code: the plugin checks every UI file the agent writes and hands the errors back to fix, and adds the MCP server and a skill.',
    '',
    '```text',
    '/plugin marketplace add dgesteves/onsystem',
    '/plugin install onsystem@dgesteves',
    '```',
    '',
    `Other agents: \`npx skills add dgesteves/onsystem\` adds the skill, and \`npx -y ${NAME}\` started in the app is the MCP server. [Set up your agent](https://onsystem.vercel.app/docs/clients) has the config for each client.`,
    '',
    '## CI',
    '',
    'In the app, record the findings it already has once, and commit the baseline, so pull requests fail only on new ones:',
    '',
    '```sh',
    `npm install --save-dev ${NAME}`,
    `npx ${NAME} check . --update-baseline`,
    '```',
    '',
    '```yaml',
    `- run: npx ${NAME} check . --format github --require-design-system`,
    '```',
    '',
    '[CI and baselines](https://onsystem.vercel.app/docs/ci) has the GitHub Action and the rest.',
    '',
    '## Changing the config',
    '',
    `${CONFIG_FILE} in ${name} sets what every app gets: where the components, tokens and docs are, and the rules' severities. Its \`tsconfig\`, \`overrides\` and \`includeDesignSystem\` apply to ${name}'s own files only. [Design-system packages](https://onsystem.vercel.app/docs/design-system-packages) has the details.`,
  ].join('\n')}\n`;
}

function count(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : `${word}s`}`;
}

/** `a`, `a and b`, `a, b and c` (or `or`). */
function andList(items: readonly string[], conjunction = 'and'): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1) ?? ''}`
    : items.join('');
}
