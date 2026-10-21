import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_SEVERITY, RULE_IDS, type ResolvedConfig } from './config.js';
import type { DesignSystem } from './design-system.js';
import { detectProject, findDesignSystemPackage, type DetectionStep } from './detect.js';
import { defaultProjectConfig } from './extract/program.js';
import { LIBRARY_IDS, notReadYet, type LibrarySource } from './libraries/index.js';
import { relativePath } from './util/paths.js';

/**
 * What `inspect --explain` says about one project: every candidate zero config looked
 * at and why each was taken or not, the config it resolved to, tokens whose value did
 * not resolve, and components without props, with the likely reason.
 */
export function explainProject(ds: DesignSystem, cwd: string, indent = ''): string[] {
  const { config, model } = ds;
  const lines: string[] = [];
  const out = (line = '') => lines.push(line ? `${indent}${line}` : '');

  out('How the design system was found');
  for (const step of packageSteps(config, cwd)) {
    out(`  ${(step.accepted ? 'found' : 'no').padEnd(6)} ${step.candidate}: ${step.reason}`);
  }
  if (config.configured) {
    out(
      `  components come from ${config.configFile ? `${display(cwd, config.configFile)}${over(config, cwd)}` : '--components'}, so zero config did not look`,
    );
  } else {
    const steps: DetectionStep[] = [];
    detectProject(config.root, config.tsconfig, steps, config.designSystemPackage);
    for (const step of steps) {
      out(`  ${(step.accepted ? 'found' : 'no').padEnd(6)} ${step.candidate}: ${step.reason}`);
    }
    if (!config.detected) {
      out(
        `  So the defaults apply: ${config.components.join(', ')}${model.stats.files.components ? '' : ', which match nothing'}.`,
      );
    }
  }
  // Published libraries, read from their type declarations whatever the config says about
  // components, unless its `libraries` leaves them out.
  const named = (library: LibrarySource) =>
    `${library.package}${library.version ? ` ${library.version}` : ''}`;
  for (const library of config.libraries ?? []) {
    const count = model.components.filter((c) => c.library === library.package).length;
    out(
      library.dir
        ? `  ${'found'.padEnd(6)} ${named(library)}: a dependency, ${count} components from its type declarations in ${display(cwd, library.dir)}`
        : `  ${'no'.padEnd(6)} ${named(library)}: a dependency, but not installed`,
    );
  }
  for (const library of config.librariesOff ?? []) {
    out(`  ${'no'.padEnd(6)} ${named(library)}: a dependency, ${librariesLeftOut(config, cwd)}`);
  }
  for (const library of config.librariesUnread ?? []) {
    out(`  ${'no'.padEnd(6)} ${named(library)}: ${notReadYet()}`);
  }

  out();
  out('Resolved config');
  const field = (name: string, value: string) => out(`  ${name.padEnd(12)} ${value}`);
  field('root', config.root);
  field(
    'config',
    config.configFile
      ? `${display(cwd, config.configFile)}${over(config, cwd)}${config.designSystemPackage ? ` (declared by ${config.designSystemPackage.name})` : ''}`
      : '(none)',
  );
  field('components', listOf(config.components) || '(none)');
  field('exclude', listOf(config.exclude));
  field(
    'tokens',
    listOf(
      config.tokens.map(
        (t) =>
          `${t.path}${t.prefix ? ` (prefix ${t.prefix})` : ''}${t.fallback ? ' (when nothing else is found)' : ''}`,
      ),
    ),
  );
  field('docs', listOf(config.docs));
  const projectConfig = defaultProjectConfig(config.root);
  field(
    'tsconfig',
    config.tsconfig ?? (projectConfig ? display(config.root, projectConfig) : '(none)'),
  );
  field('importPath', importPaths(ds));
  field(
    'libraries',
    config.libraryIds === undefined
      ? `every library onsystem reads (${LIBRARY_IDS.join(', ')})`
      : config.libraryIds !== false && config.libraryIds.length
        ? config.libraryIds.join(', ')
        : `none ("libraries": ${JSON.stringify(config.libraryIds)})`,
  );
  if (config.tailwindConfig) field('tailwind', display(config.root, config.tailwindConfig));
  if (config.designSystems) {
    // Imports are counted to rank several design systems; a registry's folder always comes last.
    const ranked = config.designSystems.filter((d) => !d.registry).length > 1;
    field(
      'primary',
      config.designSystems
        .map(
          (d, i) =>
            `${i ? 'then ' : ''}${d.source}${d.registry ? ', read-only' : ranked ? ` (${d.imports} imports)` : ''}`,
        )
        .join('; '),
    );
  }
  const changed = RULE_IDS.filter((id) => config.rules[id].severity !== DEFAULT_SEVERITY[id]);
  field(
    'rules',
    `${RULE_IDS.map((id) => `${id} ${config.rules[id].severity}`).join(', ')}${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`,
  );
  if (config.overrides?.length) {
    for (const override of config.overrides) {
      field(
        'override',
        `${override.files.join(', ')}: ${Object.entries(override.rules)
          .map(([id, rule]) => `${id} ${rule.severity}`)
          .join(', ')}`,
      );
    }
  }
  if (config.base) field('relative to', `${config.base} (a config at the workspace root)`);

  out();
  out('Tokens');
  const found = ds.tokens;
  const files = model.stats.files.tokens;
  // A library's theme (MUI's `createTheme`) is read from the app's source, not the token globs.
  const themed = found.filter((t) => t.origin === 'library');
  const fromFiles = found.length - themed.length;
  out(
    `  ${fromFiles} tokens from ${files} ${files === 1 ? 'file' : 'files'}${files ? '' : `: no file matches ${config.tokens.map((t) => t.path).join(', ')}`}`,
  );
  if (themed.length) {
    const sources = [...new Set(themed.map((t) => t.source.file))];
    out(`  ${themed.length} tokens from a library's theme in ${sources.join(', ')}`);
  }
  // A value that still reads a custom property no token file defines (`var(--brand-500)`).
  const defined = new Set(found.map((t) => t.cssVar).filter((v): v is string => Boolean(v)));
  const missing = (value: string) =>
    [...value.matchAll(/var\(\s*(--[\w-]+)/g)]
      .map((m) => m[1] ?? '')
      .filter((v) => !defined.has(v));
  const unresolved = found.filter((t) => missing(t.value).length);
  if (unresolved.length) {
    out(
      `  ${unresolved.length} unresolved, reading a custom property no token file defines: ${unresolved
        .slice(0, 8)
        .map((t) => `${t.cssVar ?? t.name}: ${t.value}`)
        .join(', ')}${unresolved.length > 8 ? `, and ${unresolved.length - 8} more` : ''}`,
    );
  } else if (found.length) {
    out('  every value resolves');
  }
  for (const warning of model.warnings.filter((w) => /alias|token/i.test(w))) out(`  ${warning}`);

  out();
  out('Props');
  const empty = ds.roots().filter((c) => c.openProps && !c.props.length && !c.inherits.length);
  const open = ds.components.filter((c) => c.openProps);
  if (!open.length) {
    out(`  every component's props resolved (${ds.components.length} components)`);
  } else {
    const installed = nodeModulesFor(config.root);
    const names = (list: typeof open) =>
      `${list
        .slice(0, 6)
        .map((c) => c.name)
        .join(', ')}${list.length > 6 ? ` and ${list.length - 6} more` : ''}`;
    if (empty.length) {
      out(
        `  ${empty.length} ${empty.length === 1 ? 'component has' : 'components have'} 0 props: ${names(empty)}.`,
      );
    }
    out(
      `  ${open.length} ${open.length === 1 ? 'component has' : 'components have'} props that did not fully resolve${empty.length === open.length ? '' : `: ${names(open)}`}, so no-unknown-prop skips ${open.length === 1 ? 'it' : 'them'}.`,
    );
    out(
      installed
        ? `  Dependencies are installed (${display(cwd, installed)}): a package without types, a type error, or a props type that depends on a type argument leaves them open.`
        : `  The dependencies are not installed: no node_modules in ${config.root} or a folder above it. Their props come from the packages they wrap (Radix, React Aria), so install them (npm install, pnpm install) and run again.`,
    );
  }
  return lines;
}

/** Why a library the project depends on is not read: `left out by "libraries" in onsystem.config.json`. */
export function librariesLeftOut(config: Pick<ResolvedConfig, 'configFile'>, cwd: string): string {
  return `left out by "libraries" in ${config.configFile ? display(cwd, config.configFile) : 'the config'}`;
}

/** The first few, then how many more: a package's exports can name hundreds of files. */
function listOf(items: readonly string[], max = 8): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown}, and ${items.length - max} more` : shown;
}

/** How components are suggested to be imported. */
function importPaths(ds: DesignSystem): string {
  if (ds.config.importPath) return `${ds.config.importPath} (from the config)`;
  const counts = new Map<string, number>();
  for (const c of ds.roots()) counts.set(c.importPath, (counts.get(c.importPath) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const from = ds.config.imports?.length ? 'package exports' : 'tsconfig paths or relative paths';
  return top.length
    ? `inferred from ${from}: ${top.map(([p, n]) => `${p} (${n})`).join(', ')}${counts.size > 3 ? `, and ${counts.size - 3} more` : ''}`
    : `inferred from ${from}`;
}

/** The nearest node_modules at or above `dir`, if any. */
export function nodeModulesFor(dir: string): string | undefined {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules');
    if (fs.existsSync(candidate)) return candidate;
    if (current === path.dirname(current)) return undefined;
  }
}

/** `, over packages/ui/onsystem.config.json` for a config read over a design-system package's. */
function over(config: ResolvedConfig, cwd: string): string {
  const declared = config.designSystemPackage;
  return declared && config.configFile !== declared.config
    ? `, over ${display(cwd, declared.config)}`
    : '';
}

function display(cwd: string, file: string): string {
  const rel = relativePath(cwd, file);
  return rel && !rel.startsWith('..') ? rel : file;
}

/**
 * Whether a dependency's declared config was read, taken on by a project without a config of its
 * own or under the one it has: the package it came from and the others that declare one, or that
 * none does.
 */
function packageSteps(config: ResolvedConfig, cwd: string): DetectionStep[] {
  const declared = config.designSystemPackage;
  // A config of its own (or --config) read alone: no dependency declares one, or it sets
  // `"extends": false`.
  if (config.configFile && !declared) return [];
  const lookup = findDesignSystemPackage(config.root);
  if (!lookup) return [];
  const candidate = "a design-system package's config";
  const skipped = lookup.skipped.length
    ? `; ${lookup.skipped.map((p) => p.name).join(', ')} ${lookup.skipped.length === 1 ? 'declares one' : 'declare one'} that cannot be read, skipped since installed`
    : '';
  if (!declared) {
    return [
      {
        candidate,
        accepted: false,
        reason: `no dependency declares one ("onsystem" in its package.json) among ${lookup.dependencies} ${lookup.dependencies === 1 ? 'dependency' : 'dependencies'}${skipped}`,
      },
    ];
  }
  return [
    {
      candidate,
      accepted: true,
      reason: `${declared.name} (${declared.installed ? 'installed' : 'a workspace package'}) declares ${display(cwd, declared.config)}, which this project ${config.configFile === declared.config ? 'takes on' : `reads under ${display(cwd, config.configFile ?? '')}`}, with its paths from ${display(cwd, declared.dir)}${lookup.others.length ? `; ${lookup.others.join(', ')} also declare one, not read: one config is taken on, from the package the code imports most` : ''}${skipped}`,
    },
  ];
}
