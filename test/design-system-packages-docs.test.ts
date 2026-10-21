import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { RULE_IDS } from '../src/config.js';
import { createServer } from '../src/server/index.js';
import { fixture, load, TSCONFIG } from './helpers.js';
import { section } from './markdown.js';

// docs/design-system-packages.md: what an app that depends on a design-system package gets, by
// how it gets the package. The package is set up with `init`, as its team would, and published
// the way npm publishes it (its `files`); the app has one mistake for each rule, so the rules
// that report are the rules that run.

const docs = fs.readFileSync(
  path.join(import.meta.dirname, '../docs/design-system-packages.md'),
  'utf8',
);
const whatAppsGet = section(docs, 'What apps get');
const inTheApps = section(docs, 'In the apps');
/** Its `### Without the config` part. */
const withoutTheConfig = whatAppsGet.slice(whatAppsGet.indexOf('\n### Without the config\n'));

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** `@acme/ui` before `init`: components in `src/`, compiled to `dist/`, tokens in `theme.css`. */
const PACKAGE = {
  'package.json': json({
    name: '@acme/ui',
    version: '1.0.0',
    files: ['dist', 'src', 'theme.css'],
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
      './theme.css': './theme.css',
    },
  }),
  'theme.css':
    '@theme {\n  --spacing: 0.25rem;\n  --color-primary: oklch(0.55 0.2 260);\n  --color-muted: oklch(0.97 0 0);\n  --radius-sm: 0.25rem;\n  --radius-md: 0.375rem;\n}\n',
  'src/index.tsx': 'export * from "./button";\nexport * from "./card";\nexport * from "./input";\n',
  'src/button.tsx':
    'export function Button(props: { variant?: "default" | "outline"; children?: unknown; "aria-label"?: string }) { return <button aria-label={props["aria-label"]} /> }\n',
  'src/card.tsx': 'export function Card(props: { children?: unknown }) { return <div /> }\n',
  'src/input.tsx': 'export function Input(props: { name?: string }) { return <input /> }\n',
  'dist/index.mjs':
    'export function Button() {}\nexport function Card() {}\nexport function Input() {}\n',
  // As tsc emits them from the sources.
  'dist/index.d.ts': [
    "import * as react from 'react';",
    "import * as react_jsx_runtime from 'react/jsx-runtime';",
    'declare function Button(props: react.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" }): react_jsx_runtime.JSX.Element;',
    'declare function Card(props: react.HTMLAttributes<HTMLDivElement>): react_jsx_runtime.JSX.Element;',
    'declare function Input(props: react.InputHTMLAttributes<HTMLInputElement>): react_jsx_runtime.JSX.Element;',
    'export { Button, Card, Input };',
    '',
  ].join('\n'),
};

/**
 * `@acme/ui` published with its sources and no build, its `exports` pointing at them: what zero
 * config reads in an app without the config.
 */
const SOURCE_PACKAGE: Record<string, string> = {
  ...Object.fromEntries(Object.entries(PACKAGE).filter(([file]) => !file.startsWith('dist/'))),
  'package.json': json({
    name: '@acme/ui',
    version: '1.0.0',
    files: ['src', 'theme.css'],
    exports: { '.': './src/index.tsx', './theme.css': './theme.css' },
  }),
};

/** One mistake per rule; the icon-only <button> on the last line breaks two. */
const PAGE = `import { Badge, Button } from "@acme/ui";

export default function Page() {
  return (
    <main>
      <div className="bg-blue-500">Color</div>
      <div className="p-[13px]">Spacing</div>
      <div className="rounded-[7px]">Radius</div>
      <input name="q" />
      <Badge>New</Badge>
      <Button tone="quiet">Save</Button>
      <Button variant="danger">Delete</Button>
      <Button><svg /></Button>
      <button><svg /></button>
    </main>
  );
}
`;
const NATIVE_BUTTON_LINE = 14;

/** An icon-only native <button> around an icon the package re-exports. */
const ICON_PAGE = `import { ChevronLeft } from "@acme/ui";

export function Back() {
  return <button><ChevronLeft /></button>;
}
`;
const ICON_BUTTON_LINE = 4;

/**
 * `@acme/ui` as shadcn's monorepo template exports it: each component by its own subpath
 * (`@acme/ui/components/button`), with no barrel.
 */
const SUBPATH_PACKAGE = {
  'package.json': json({
    name: '@acme/ui',
    version: '1.0.0',
    files: ['src', 'theme.css'],
    exports: { './components/*': './src/components/*.tsx', './theme.css': './theme.css' },
  }),
  'theme.css': PACKAGE['theme.css'],
  'src/components/button.tsx': PACKAGE['src/button.tsx'],
  'src/components/card.tsx': PACKAGE['src/card.tsx'],
  'src/components/input.tsx': PACKAGE['src/input.tsx'],
};

/** The same page, importing each component by its subpath: one line longer. */
const SUBPATH_PAGE = PAGE.replace(
  'import { Badge, Button } from "@acme/ui";',
  'import { Badge } from "@acme/ui/components/badge";\nimport { Button } from "@acme/ui/components/button";',
);

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, color: false, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await main(args, io);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

type Results = { diagnostics: { ruleId: string; line: number; message: string }[] }[];

/** `check app/page.tsx` in the app: the findings, the rules they come from, and stderr. */
async function check(app: string) {
  const { code, stdout, stderr } = await run(
    ['check', 'app/page.tsx', '--format', 'json', '--no-cache'],
    app,
  );
  const findings = (JSON.parse(stdout) as Results).flatMap((r) => r.diagnostics);
  return { code, findings, rules: new Set(findings.map((d) => d.ruleId)), stderr };
}

/** The package after `init --yes` in it, file by file, set up once for the file. */
const setUp = new Map<Record<string, string>, Promise<Record<string, string>>>();
function initialised(files: Record<string, string> = PACKAGE): Promise<Record<string, string>> {
  let pkg = setUp.get(files);
  if (!pkg) {
    pkg = initialise(files);
    setUp.set(files, pkg);
  }
  return pkg;
}

async function initialise(source: Record<string, string>): Promise<Record<string, string>> {
  const dir = fixture(source);
  expect((await run(['init', '--yes', '--no-cache'], dir)).code).toBe(0);
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file);
      else files[file] = fs.readFileSync(path.join(dir, file), 'utf8');
    }
  };
  walk('');
  return files;
}

/** What npm publishes of the package: `package.json` and what its `files` list names. */
function published(pkg: Record<string, string>): Record<string, string> {
  const files = (JSON.parse(pkg['package.json'] ?? '{}') as { files: string[] }).files;
  return Object.fromEntries(
    Object.entries(pkg).filter(
      ([file]) =>
        file === 'package.json' ||
        files.some((entry) => file === entry || file.startsWith(`${entry}/`)),
    ),
  );
}

const at = (prefix: string, files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([file, text]) => [`${prefix}/${file}`, text]));

/**
 * An app that installs the package from a registry, with `pkg` in node_modules. With `react`,
 * React's types are installed too, which type declarations need to declare a component.
 */
function installedApp(
  pkg: Record<string, string>,
  extra: Record<string, string> = {},
  { react = false, name = 'web' }: { react?: boolean; name?: string } = {},
): string {
  return fixture(
    {
      'package.json': json({
        name,
        dependencies: { '@acme/ui': '1.0.0', ...(react ? { react: '19.0.0' } : {}) },
      }),
      ...(react ? { 'tsconfig.json': TSCONFIG } : {}),
      'app/page.tsx': PAGE,
      ...at('node_modules/@acme/ui', pkg),
      ...extra,
    },
    { nodeModules: react },
  );
}

/** A published package without its type declarations: no `.d.ts`, and no `types` to name one. */
function withoutTypes(pkg: Record<string, string>): Record<string, string> {
  const manifest = JSON.parse(pkg['package.json'] ?? '{}') as {
    exports: Record<string, unknown>;
  };
  const { types: _, ...main } = manifest.exports['.'] as Record<string, unknown>;
  return {
    ...without(pkg, (file) => file.endsWith('.d.ts')),
    'package.json': json({ ...manifest, exports: { ...manifest.exports, '.': main } }),
  };
}

/** A pnpm monorepo: the package in packages/ui, and the app in apps/web. Returns the app. */
function workspaceApp(pkg: Record<string, string>, extra: Record<string, string> = {}): string {
  const root = fixture({
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'package.json': json({ name: 'acme', private: true }),
    ...at('packages/ui', pkg),
    'apps/web/package.json': json({ name: 'web', dependencies: { '@acme/ui': 'workspace:*' } }),
    'apps/web/app/page.tsx': PAGE,
    ...at('apps/web', extra),
  });
  return path.join(root, 'apps/web');
}

const without = (files: Record<string, string>, drop: (file: string) => boolean) =>
  Object.fromEntries(Object.entries(files).filter(([file]) => !drop(file)));

/** The package's config with `edit` applied. */
function withConfig(
  pkg: Record<string, string>,
  edit: (config: Record<string, unknown>) => Record<string, unknown>,
): Record<string, string> {
  const config = JSON.parse(pkg['onsystem.config.json'] ?? '{}') as Record<string, unknown>;
  return { ...pkg, 'onsystem.config.json': json(edit(config)) };
}

/** The table's rows, as [how the app gets the package, rules that run]. */
function rows(): [string, string][] {
  return whatAppsGet
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .slice(2)
    .map((line) => {
      const [, how = '', rules = ''] = line.split('|').map((cell) => cell.trim());
      return [how, rules];
    });
}

/** The rule ids a cell names: every rule for "All eight". */
function rulesIn(cell: string): Set<string> {
  if (cell.startsWith('All eight')) return new Set(RULE_IDS);
  const named = [...cell.matchAll(/`([a-z-]+)`/g)].map((m) => m[1] ?? '');
  return new Set(named.filter((id) => (RULE_IDS as readonly string[]).includes(id)));
}

/** Calls one MCP tool on the app's design system. */
async function tool(root: string, name: string, args: Record<string, unknown>): Promise<string> {
  const ds = await load(root);
  const server = createServer({ getDesignSystem: () => Promise.resolve(ds) });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    return first?.type === 'text' ? first.text : '';
  } finally {
    await client.close();
  }
}

describe('what apps get from a design-system package (docs/design-system-packages.md)', () => {
  it('has a row for a workspace package and for five ways of publishing one', () => {
    expect(rows().map(([how]) => how)).toEqual([
      'As a workspace package',
      'From a registry, with the config, the token files and the component sources (`src/`) published',
      'From a registry, with the config, the token files, compiled `dist/` and its type declarations (`.d.ts`) published, but not `src/`',
      'From a registry, with the config, the token files and compiled `dist/` published, but neither `src/` nor type declarations',
      'From a registry, without the config, named like a design system (`@acme/ui`), with `exports` that point at the component sources (`./src/index.ts`)',
      'From a registry, without the config, with `exports` that point at `dist/`, or named otherwise (`@acme/kit`)',
    ]);
    expect(RULE_IDS).toHaveLength(8);
  });

  it('runs every rule from a workspace package, and from one published with src/', async () => {
    const pkg = await initialised();
    const [workspace, withSources] = rows();
    expect((await check(workspaceApp(pkg))).rules).toEqual(rulesIn(workspace?.[1] ?? ''));
    expect((await check(installedApp(published(pkg)))).rules).toEqual(
      rulesIn(withSources?.[1] ?? ''),
    );
  });

  it('runs every rule from a package published as dist/ with its type declarations, which give its components', async () => {
    const pkg = await initialised();
    const distOnly = without(published(pkg), (file) => file.startsWith('src/'));
    const app = installedApp(distOnly, {}, { react: true });
    const { rules, stderr } = await check(app);
    expect(rules).toEqual(rulesIn(rows()[2]?.[1] ?? ''));
    expect(rows()[2]?.[1]).toBe('All eight, from its type declarations');
    expect(stderr).not.toContain('No design-system components found');
    const library =
      'library  Design-system package (@acme/ui 1.0.0): 3 components from its type declarations';
    expect((await run(['inspect', '--no-cache'], app)).stdout).toContain(library);
    expect(whatAppsGet).toContain(`\`${library}\``);
    expect(await tool(app, 'get_component', { name: 'Button' })).toContain('@acme/ui');
    expect(whatAppsGet).toContain(
      'every rule runs, and agents find the components with `list_components`, `search_components` and `get_component`.',
    );
    // --require-design-system finds the design system (exit code 2 would say it did not).
    expect((await run(['check', '.', '--require-design-system', '--no-cache'], app)).code).toBe(1);
  });

  it('runs the token rules from a package published without src/ or type declarations, and says the component rules did not run', async () => {
    const pkg = await initialised();
    const withTypes = without(published(pkg), (file) => file.startsWith('src/'));
    expect(Object.keys(withTypes).sort()).toEqual([
      'dist/index.d.ts',
      'dist/index.mjs',
      'onsystem.config.json',
      'package.json',
      'theme.css',
    ]);
    // init's config, as published: apps import the package by one name, so it sets importPath.
    expect(JSON.parse(withTypes['onsystem.config.json'] ?? '{}')).toMatchObject({
      importPath: '@acme/ui',
    });
    expect(whatAppsGet).toContain('When the package publishes no type declarations either:');
    const app = installedApp(withoutTypes(withTypes), {}, { react: true });
    const { rules, findings, stderr } = await check(app);
    const cell = rows()[3]?.[1] ?? '';
    expect(rules).toEqual(rulesIn(cell));
    // The icon rule runs on the native <button> only: the package's <Button> is not known.
    expect(
      findings.filter((d) => d.ruleId === 'icon-button-accessible-name').map((d) => d.line),
    ).toEqual([NATIVE_BUTTON_LINE]);
    expect(whatAppsGet).toContain('`icon-button-accessible-name` on native elements');
    // The notice, and no component rule reports.
    const notice = 'No design-system components found: the component rules did not run.';
    expect(stderr).toContain(notice);
    for (const rule of ['no-unknown-component', 'no-unknown-prop', 'no-unknown-variant']) {
      expect(rules).not.toContain(rule);
    }
    expect(whatAppsGet).toContain(
      '`no-unknown-component`, `no-unknown-prop` and `no-unknown-variant` check none of the components the app imports from the package',
    );
    expect(whatAppsGet).toContain(`\`check\` says \`${notice}\`\n`);
    // Agents find no component.
    expect(await tool(app, 'list_components', {})).toMatch(/^No components found/);
    expect(await tool(app, 'search_components', { query: 'button' })).toMatch(
      /^No components match/,
    );
    expect(await tool(app, 'get_component', { name: 'Button' })).toMatch(
      /^No component named "Button"/,
    );
    // check_ui reports from the same rules.
    const checked = await tool(app, 'check_ui', { path: 'app/page.tsx' });
    expect(new Set([...checked.matchAll(/ \[([a-z-]+)\] /g)].map((m) => m[1]))).toEqual(rules);
    // --require-design-system fails, with exit code 2.
    const required = await run(['check', '.', '--require-design-system', '--no-cache'], app);
    expect(required.code).toBe(2);
    expect(whatAppsGet).toContain('**`--require-design-system` fails** (exit code 2)');
  });

  it('checks no component imported from a package published without src/ or type declarations, with importPath or without it, but knows its icons only with it', async () => {
    const pkg = await initialised();
    const distOnly = withoutTypes(without(published(pkg), (file) => file.startsWith('src/')));
    const noImportPath = (files: Record<string, string>) =>
      withConfig(files, ({ importPath: _, ...config }) => config);
    expect(whatAppsGet).toContain(
      '**`importPath` does not turn the component rules on**, with no declarations to read. `init` sets it when apps import the package by one name, such as `@acme/ui`.',
    );
    // <Badge>, which the package does not have, is not reported either.
    const expected = rulesIn(rows()[3]?.[1] ?? '');
    const withImportPath = await check(installedApp(distOnly));
    expect(withImportPath.rules).toEqual(expected);
    expect(withImportPath.findings.filter((d) => d.message.includes('Badge'))).toEqual([]);
    expect(whatAppsGet).toContain(
      'With no component to compare against, imports from the package are not checked: `<Badge>` from `@acme/ui` is not reported, although the package has no `Badge`.',
    );
    const withoutImportPath = await check(installedApp(noImportPath(distOnly)));
    expect(withoutImportPath.rules).toEqual(expected);
    // An icon the package re-exports, in a native <button>: an icon only with importPath.
    const withIcon = {
      ...distOnly,
      'dist/index.mjs': `${distOnly['dist/index.mjs'] ?? ''}export function ChevronLeft() {}\n`,
    };
    const iconPage = { 'app/page.tsx': ICON_PAGE };
    const icon = await check(installedApp(withIcon, iconPage));
    expect(icon.findings.map((d) => [d.ruleId, d.line])).toEqual([
      ['icon-button-accessible-name', ICON_BUTTON_LINE],
    ]);
    expect(icon.code).toBe(1);
    const iconWithoutImportPath = await check(installedApp(noImportPath(withIcon), iconPage));
    expect(iconWithoutImportPath.findings).toEqual([]);
    expect(iconWithoutImportPath.code).toBe(0);
    expect(whatAppsGet).toContain(
      'It still tells `icon-button-accessible-name` that an icon the package re-exports is an icon, so `<button><ChevronLeft /></button>`, with `ChevronLeft` from `@acme/ui`, is reported for having no accessible name. Without `importPath`, that button is not reported.',
    );
  });

  it('gets nothing from a package published without its config, with a warning', async () => {
    const pkg = await initialised();
    const bare = without(
      published(pkg),
      (file) => !file.startsWith('dist/') && file !== 'package.json',
    );
    const { rules, stderr } = await check(installedApp(bare));
    expect(stderr).toContain("@acme/ui's onsystem config was skipped");
    // The app itself has no components or tokens: only the accessibility rule, on <button>.
    expect(rules).toEqual(new Set(['icon-button-accessible-name']));
    expect(rows()[5]?.[1]).toContain(
      'A declaration whose config is not published is skipped with a warning',
    );
  });

  it("reads the components of a package without the config from its type declarations in the app's scope, or named by its importPath", async () => {
    const distOnly = without(published(PACKAGE), (file) => file.startsWith('src/'));
    expect(rows()[5]?.[1]).toContain(
      "unless the package publishes type declarations and is named like a design system in the app's own npm scope (`@acme/ui` for `@acme/web`), or the app's `importPath` names it: then its components are read from them.",
    );
    const componentRules = ['no-unknown-component', 'no-unknown-prop', 'no-unknown-variant'];
    const scoped = await check(installedApp(distOnly, {}, { react: true, name: '@acme/web' }));
    const named = await check(
      installedApp(
        distOnly,
        { 'onsystem.config.json': json({ importPath: '@acme/ui' }) },
        { react: true },
      ),
    );
    const unscoped = await check(installedApp(distOnly, {}, { react: true }));
    for (const rule of componentRules) {
      expect(scoped.rules).toContain(rule);
      expect(named.rules).toContain(rule);
      expect(unscoped.rules).not.toContain(rule);
    }
  });

  it('runs every rule from a package named like a design system whose exports point at its sources, with no config', async () => {
    const cell = rows()[4]?.[1] ?? '';
    expect(cell).toMatch(/^All eight, through zero config/);
    // As published before init: no config, and no declaration.
    const app = installedApp(published(SOURCE_PACKAGE));
    expect((await check(app)).rules).toEqual(rulesIn(cell));
    const explained = await run(['inspect', '--explain', '--no-cache'], app);
    const found = 'found  installed package @acme/ui: node_modules/@acme/ui, 3 component files';
    expect(explained.stdout).toContain(found);
    expect(withoutTheConfig).toContain(`\`${found}\``);
    // A declaration whose config is not published: skipped, and the package read the same way.
    const pkg = await initialised(SOURCE_PACKAGE);
    const unpublished = without(published(pkg), (file) => file === 'onsystem.config.json');
    const skipped = await check(installedApp(unpublished));
    expect(skipped.stderr).toContain("@acme/ui's onsystem config was skipped");
    expect(skipped.rules).toEqual(rulesIn(cell));
    expect(withoutTheConfig).toContain(
      'An app reads an installed package that declares no config, or whose declared config is not published, as zero config reads a workspace package',
    );
  });

  it('reads no component from a package without the config whose exports point at dist/, with src/ published or not, and says why', async () => {
    const why =
      'no     installed package @acme/ui: its exports point at build output (node_modules/@acme/ui/dist/index.mjs), not at component sources, and only sources are read';
    expect(withoutTheConfig).toContain(`\`${why}\``);
    expect(rows()[5]?.[0]).toContain('with `exports` that point at `dist/`');
    const distOnly = without(published(PACKAGE), (file) => file.startsWith('src/'));
    // A `source` condition for the package's own repository, before the build that apps get.
    const sourceCondition = {
      ...published(PACKAGE),
      'package.json': json({
        name: '@acme/ui',
        version: '1.0.0',
        files: ['dist', 'src', 'theme.css'],
        exports: {
          '.': {
            source: './src/index.tsx',
            types: './dist/index.d.ts',
            import: './dist/index.mjs',
          },
          './theme.css': './theme.css',
        },
      }),
    };
    for (const pkg of [published(PACKAGE), distOnly, sourceCondition]) {
      const app = installedApp(pkg);
      const { rules } = await check(app);
      expect(rules).toEqual(new Set(['icon-button-accessible-name']));
      const explained = await run(['inspect', '--explain', '--no-cache'], app);
      expect(explained.stdout).toContain(why);
    }
    expect(withoutTheConfig).toContain(
      'Unlike in a workspace package, exports that point at `dist/` are not followed back to `src/`',
    );
    expect(withoutTheConfig).toContain(
      "A condition for the package's own repository, such as `source` (react-native-builder-bob) or `expo-source` (`@expo/ui`), is passed over",
    );
  });

  it('reads a package through each condition the docs list, and through no other', async () => {
    const sentence =
      /read through the conditions an app resolves: those of Node\.js \(([^)]*)\), and ([^.]*)\./.exec(
        withoutTheConfig,
      );
    const listed = [
      ...`${sentence?.[1] ?? ''} ${sentence?.[2] ?? ''}`.matchAll(/`([a-z-]+)`/g),
    ].map((m) => m[1] ?? '');
    expect(listed).toEqual([
      'import',
      'require',
      'module-sync',
      'node',
      'default',
      'module',
      'browser',
      'style',
    ]);
    const detected = async (condition: string) => {
      const pkg = {
        ...SOURCE_PACKAGE,
        'package.json': json({
          name: '@acme/ui',
          version: '1.0.0',
          files: ['src', 'theme.css'],
          exports: { '.': { [condition]: './src/index.tsx' }, './theme.css': './theme.css' },
        }),
      };
      return (await load(installedApp(published(pkg)))).config.detected;
    };
    for (const condition of [...listed, 'development', 'react-native']) {
      expect([condition, await detected(condition)]).toEqual([
        condition,
        listed.includes(condition) ? 'installed package @acme/ui' : undefined,
      ]);
    }
  });

  it('reads no component through an export that points at JavaScript outside a build folder', async () => {
    // A `.js` barrel in front of `.jsx` files, published without a build.
    const jsBarrel = {
      'package.json': json({
        name: '@acme/ui',
        version: '1.0.0',
        files: ['index.js', 'src', 'theme.css'],
        exports: { '.': './index.js', './theme.css': './theme.css' },
      }),
      'theme.css': PACKAGE['theme.css'],
      'index.js':
        'export * from "./src/button.jsx";\nexport * from "./src/card.jsx";\nexport * from "./src/input.jsx";\n',
      'src/button.jsx':
        'export function Button({ variant }) { return <button data-variant={variant} /> }\n',
      'src/card.jsx': 'export function Card({ children }) { return <div>{children}</div> }\n',
      'src/input.jsx': 'export function Input({ name }) { return <input name={name} /> }\n',
    };
    const app = installedApp(published(jsBarrel));
    expect((await check(app)).rules).toEqual(new Set(['icon-button-accessible-name']));
    const explained = await run(['inspect', '--explain', '--no-cache'], app);
    expect(explained.stdout).toContain(
      'no     installed package @acme/ui: its exports point at build output (node_modules/@acme/ui/index.js), not at component sources, and only sources are read',
    );
    expect(withoutTheConfig).toContain(
      'and no export that points at JavaScript in any other folder (`./index.js`, `./es/index.mjs`, `./build-module/index.js`), whose re-exports are not followed. So a package that publishes a `.js` barrel in front of its `.jsx` files is not read either',
    );
  });

  it('runs the token rules only for what the published tokens define', async () => {
    const pkg = await initialised();
    const distOnly = withoutTypes(without(published(pkg), (file) => file.startsWith('src/')));
    const colorsOnly = {
      ...withConfig(distOnly, ({ importPath: _, ...config }) => config),
      'theme.css': '@theme {\n  --color-primary: oklch(0.55 0.2 260);\n}\n',
    };
    expect((await check(installedApp(colorsOnly))).rules).toEqual(
      new Set(['no-hardcoded-color', 'icon-button-accessible-name']),
    );
    expect(whatAppsGet).toContain(
      '`no-hardcoded-color` when they hold colors, `no-hardcoded-spacing` and `no-hardcoded-radius` when they set a spacing scale and radii',
    );
  });
});

describe("an app's own config (docs/design-system-packages.md#an-apps-own-config)", () => {
  const own = json({ rules: { 'no-hardcoded-color': 'warn' } });
  /** The same, read alone. */
  const alone = json({ extends: false, rules: { 'no-hardcoded-color': 'warn' } });

  it("builds on the package's: a config that only changes a rule's severity keeps every rule", async () => {
    const pkg = await initialised();
    expect(inTheApps).toContain(
      'So a config that only changes a rule\'s severity, `{ "rules": { "no-hardcoded-color": "warn" } }`, keeps the package\'s components and tokens, and every other rule as the package sets it.',
    );
    for (const app of [
      installedApp(published(pkg), { 'onsystem.config.json': own }),
      workspaceApp(pkg, { 'onsystem.config.json': own }),
    ]) {
      const { rules, findings } = await check(app);
      expect(rules).toEqual(new Set(RULE_IDS));
      expect(findings.find((d) => d.ruleId === 'no-hardcoded-color')?.line).toBe(6);
    }
    const inspected = await run(
      ['inspect', '--no-cache'],
      installedApp(published(pkg), { 'onsystem.config.json': own }),
    );
    const line =
      'config   onsystem.config.json, over node_modules/@acme/ui/onsystem.config.json (declared by @acme/ui)';
    expect(inspected.stdout.replaceAll('\\', '/')).toContain(`${line}\n`);
    expect(inTheApps).toContain(`\`\`\`text\n${line}\n\`\`\``);
  });

  it('is read alone with "extends": false, which can leave the app without the components and tokens of a package whose exports point at dist/', async () => {
    const pkg = await initialised();
    const app = installedApp(withoutTypes(published(pkg)), { 'onsystem.config.json': alone });
    const { rules, stderr } = await check(app);
    expect(rules).toEqual(new Set(['icon-button-accessible-name']));
    expect(stderr).toContain('No design system found (no components or color tokens)');
    // Type declarations it publishes are still read, since it declares its config.
    const declarations = await check(
      installedApp(
        without(published(pkg), (file) => file.startsWith('src/')),
        { 'onsystem.config.json': alone },
        { react: true },
      ),
    );
    expect(declarations.rules).toContain('no-unknown-variant');
    expect(declarations.rules).not.toContain('no-hardcoded-color');
    expect(inTheApps).toContain(
      'of those, it reads only the type declarations a package publishes, when it declares its config',
    );
    expect(inTheApps).toContain('`"extends": false` in the app\'s config reads it alone.');
    expect(inTheApps).toContain(
      "So such a config that only changes a rule's severity can leave the app without the package's components and tokens, and `check` then says which rules did not run.",
    );
  });

  it('still finds a package named like a design system through zero config with "extends": false, in the workspace or installed with exports that point at its sources', async () => {
    const pkg = await initialised();
    const config = { 'onsystem.config.json': alone };
    expect((await check(workspaceApp(pkg, config))).rules).toContain('no-unknown-variant');
    const sources = await initialised(SOURCE_PACKAGE);
    expect((await check(installedApp(published(sources), config))).rules).toContain(
      'no-unknown-variant',
    );
    expect(inTheApps).toContain(
      'it finds a package named like a design system, as a workspace package or installed in `node_modules` with `exports` that point at its component sources ([without the config](#without-the-config)), but not one named otherwise (`@acme/kit`) or one whose `exports` point at compiled code:',
    );
  });

  it('gets every rule back with "extends": false and the package\'s components, importPath and tokens copied in', async () => {
    const pkg = await initialised();
    const config = JSON.parse(pkg['onsystem.config.json'] ?? '{}') as {
      importPath: string;
      tokens: string[];
    };
    const globs = {
      installed: 'node_modules/@acme/ui/src/**/*.tsx',
      workspace: '../../packages/ui/src/**/*.tsx',
    };
    expect(inTheApps).toContain(
      `\`${globs.installed}\`, or \`${globs.workspace}\` from a workspace app`,
    );
    const copied = (glob: string) =>
      json({
        extends: false,
        components: [glob],
        importPath: config.importPath,
        tokens: config.tokens.map((t) => `${glob.split('/src/')[0]}/${t}`),
        rules: { 'no-hardcoded-color': 'warn' },
      });
    const installed = installedApp(published(pkg), {
      'onsystem.config.json': copied(globs.installed),
    });
    expect((await check(installed)).rules).toEqual(new Set(RULE_IDS));
    const workspace = workspaceApp(pkg, { 'onsystem.config.json': copied(globs.workspace) });
    expect((await check(workspace)).rules).toEqual(new Set(RULE_IDS));
  });

  it("is what init --force writes in the app: $schema alone, building on the package's", async () => {
    const pkg = await initialised();
    const app = installedApp(published(pkg));
    const init = await run(['init', '--yes', '--force', '--no-cache'], app);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(
      'With --force it has one of its own, onsystem.config.json, read over that one: what it leaves out, such as "components", "importPath" and "tokens", still comes from @acme/ui\'s config',
    );
    expect(JSON.parse(fs.readFileSync(path.join(app, 'onsystem.config.json'), 'utf8'))).toEqual({
      $schema: 'https://unpkg.com/onsystem/schema.json',
    });
    expect(inTheApps).toContain(
      "`init --force` in an app on such a package writes a config with only `$schema` in it, for the app's own rules and overrides, and says what it builds on.",
    );
    fs.rmSync(path.join(app, 'onsystem.baseline.json'));
    expect((await check(app)).rules).toEqual(new Set(RULE_IDS));
  });

  it('needs importPath set to the package name for a package imported by subpath, when read alone', async () => {
    const pkg = await initialised(SUBPATH_PACKAGE);
    const config = JSON.parse(pkg['onsystem.config.json'] ?? '{}') as {
      components: string[];
      tokens: string[];
    };
    // `@acme/ui/components/*` is no import that compiles, so init writes no importPath.
    expect(config).not.toHaveProperty('importPath');
    expect(inTheApps).toContain(
      "`init` writes no `importPath` for a package that apps import by subpath (`@acme/ui/components/button`), so when the package's config has none, set it to the package's name (`@acme/ui`).",
    );
    expect(inTheApps).toContain(
      "Without it, `no-unknown-component`, `no-unknown-prop`, `no-unknown-variant`, and `icon-button-accessible-name` on the package's `<Button>`, check none of the app's imports from the package, and nothing says so.",
    );
    expect(inTheApps).toContain(
      "With it, the same rules run as with the package's config, but the imports that findings and `get_component` suggest name `@acme/ui`, not the subpath.",
    );
    const page = { 'app/page.tsx': SUBPATH_PAGE };
    const iconLines = (findings: { ruleId: string; line: number }[]) =>
      findings.filter((d) => d.ruleId === 'icon-button-accessible-name').map((d) => d.line);
    const inputImport = (findings: { message: string }[]) =>
      findings.map((d) => /import \{ Input \} from "([^"]+)"/.exec(d.message)?.[1]).find(Boolean);
    const layouts = [
      ['node_modules/@acme/ui', installedApp],
      ['../../packages/ui', workspaceApp],
    ] as const;
    for (const [prefix, app] of layouts) {
      const copied = (importPath?: string) =>
        json({
          extends: false,
          components: config.components.map((glob) => `${prefix}/${glob}`),
          ...(importPath ? { importPath } : {}),
          tokens: config.tokens.map((file) => `${prefix}/${file}`),
          rules: { 'no-hardcoded-color': 'warn' },
        });
      // No config of its own: the package's config, imports by subpath.
      const declared = await check(app(pkg, page));
      expect(declared.rules).toContain('no-unknown-prop');
      expect(declared.rules).toContain('no-unknown-variant');
      expect(iconLines(declared.findings)).toEqual([NATIVE_BUTTON_LINE, NATIVE_BUTTON_LINE + 1]);
      expect(inputImport(declared.findings)).toBe('@acme/ui/components/input');
      // A config of its own that builds on the package's: the same, imports by subpath.
      const layered = await check(app(pkg, { ...page, 'onsystem.config.json': own }));
      expect(layered.rules).toEqual(declared.rules);
      expect(iconLines(layered.findings)).toEqual([NATIVE_BUTTON_LINE, NATIVE_BUTTON_LINE + 1]);
      expect(inputImport(layered.findings)).toBe('@acme/ui/components/input');
      // Copied without importPath: the package's imports go unchecked, without a word.
      const bare = await check(app(pkg, { ...page, 'onsystem.config.json': copied() }));
      for (const rule of ['no-unknown-component', 'no-unknown-prop', 'no-unknown-variant']) {
        expect(bare.rules).not.toContain(rule);
      }
      expect(iconLines(bare.findings)).toEqual([NATIVE_BUTTON_LINE + 1]);
      expect(bare.stderr).toBe('');
      // With the package's name as importPath: the same rules as the package's config.
      const named = app(pkg, { ...page, 'onsystem.config.json': copied('@acme/ui') });
      const withName = await check(named);
      expect(withName.rules).toEqual(declared.rules);
      expect(iconLines(withName.findings)).toEqual([NATIVE_BUTTON_LINE, NATIVE_BUTTON_LINE + 1]);
      expect(inputImport(withName.findings)).toBe('@acme/ui');
      expect(await tool(named, 'get_component', { name: 'Button' })).toContain(
        'import { Button } from "@acme/ui"\n',
      );
    }
  });
});
