import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { DEFAULT_DOCS, loadConfig } from '../src/config.js';
import { loadTarget } from '../src/workspace.js';
import { fixture, TSCONFIG } from './helpers.js';

// An app's own config builds on the config its design-system package declares: what it leaves
// out comes from the package's, and its rules apply over the package's. A workspace root's
// config, from the root, builds on it the same way. Before, either one replaced the package's:
// an app config that only turned one rule to "warn" lost the package's components and tokens,
// and `check` passed.

const json = (value: unknown) => JSON.stringify(value, null, 2);

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, color: false, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await main(args, io);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

type Results = {
  file: string;
  diagnostics: { ruleId: string; severity: string; line: number; message: string }[];
}[];

/** `check <target>`: its exit code, stderr, and each finding as `file:line rule severity`. */
async function check(cwd: string, target = '.') {
  const { code, stdout, stderr } = await run(
    ['check', target, '--format', 'json', '--no-cache'],
    cwd,
  );
  const findings = (JSON.parse(stdout) as Results).flatMap((r) =>
    r.diagnostics.map((d) => `${r.file}:${d.line} ${d.ruleId} ${d.severity}`),
  );
  return { code, stderr, findings, rules: new Set(findings.map((f) => f.split(' ')[1])) };
}

const BUTTON =
  'export function Button(props: { variant?: "default" | "outline"; children?: unknown }) { return <button /> }\n';
const CARD = 'export function Card(props: { children?: unknown }) { return <div /> }\n';
const INPUT = 'export function Input(props: { name?: string }) { return <input /> }\n';
const TABLE = 'export function Table(props: { children?: unknown }) { return <table /> }\n';
const THEME =
  '@theme {\n  --spacing: 0.25rem;\n  --color-primary: oklch(0.55 0.2 260);\n  --radius-md: 0.375rem;\n}\n';

/** `@acme/ui` as npm installs it: its sources, its theme and the config `init` declared. */
function acmeUi(config: Record<string, unknown>): Record<string, string> {
  return {
    'package.json': json({
      name: '@acme/ui',
      version: '1.0.0',
      files: ['dist', 'src', 'theme.css', 'onsystem.config.json'],
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
        './theme.css': './theme.css',
      },
      onsystem: './onsystem.config.json',
    }),
    'onsystem.config.json': json(config),
    'theme.css': THEME,
    'src/index.tsx':
      'export * from "./button";\nexport * from "./card";\nexport * from "./input";\n',
    'src/button.tsx': BUTTON,
    'src/card.tsx': CARD,
    'src/input.tsx': INPUT,
    'dist/index.mjs': 'export function Button() {}\n',
  };
}

/** The config `init --yes` writes in `@acme/ui`. */
const INIT_CONFIG = {
  components: ['src/button.tsx', 'src/card.tsx', 'src/input.tsx'],
  importPath: '@acme/ui',
  tokens: ['theme.css'],
};

/** One mistake for each rule but the icon one. */
const PAGE = `import { Badge, Button } from "@acme/ui";

export default function Page() {
  return (
    <main>
      <div className="bg-blue-500">Color</div>
      <div className="p-[13px]">Spacing</div>
      <input name="q" />
      <Badge>New</Badge>
      <Button tone="quiet">Save</Button>
      <Button variant="danger">Delete</Button>
    </main>
  );
}
`;

const at = (prefix: string, files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([file, text]) => [`${prefix}/${file}`, text]));

/** An app that installs `@acme/ui` from a registry, with `extra` files of its own. */
function installedApp(pkg: Record<string, string>, extra: Record<string, string> = {}): string {
  return fixture({
    'package.json': json({ name: 'web', dependencies: { '@acme/ui': '1.0.0' } }),
    'app/page.tsx': PAGE,
    ...at('node_modules/@acme/ui', pkg),
    ...extra,
  });
}

const ONE_RULE = json({ rules: { 'no-hardcoded-color': 'warn' } });
const COMPONENT_RULES = [
  'prefer-design-system-component',
  'no-unknown-component',
  'no-unknown-prop',
  'no-unknown-variant',
];

describe("an app's own config, on a design-system package that declares one", () => {
  it("keeps the package's components and tokens when it only changes a rule's severity", async () => {
    const app = installedApp(acmeUi(INIT_CONFIG), { 'onsystem.config.json': ONE_RULE });
    const { code, stderr, findings, rules } = await check(app);
    expect(stderr).not.toContain('No design system found');
    for (const rule of COMPONENT_RULES) expect(rules).toContain(rule);
    expect(findings).toContain('app/page.tsx:6 no-hardcoded-color warning');
    expect(findings).toContain('app/page.tsx:7 no-hardcoded-spacing warning');
    expect(code).toBe(1);

    const config = await loadConfig({ root: app });
    expect(config.configFile).toBe(path.join(app, 'onsystem.config.json'));
    expect(config.designSystemPackage?.name).toBe('@acme/ui');
    expect(config.importPath).toBe('@acme/ui');
    expect(config.tokens.map((t) => t.path)).toEqual(['node_modules/@acme/ui/theme.css']);

    const inspect = await run(['inspect', '--no-cache'], app);
    expect(inspect.stdout).toContain(
      `config   onsystem.config.json, over ${path.join('node_modules', '@acme', 'ui', 'onsystem.config.json')} (declared by @acme/ui)\n`,
    );
    expect(inspect.stdout).toContain('files    3 component files, 1 token file');
    const explained = await run(['inspect', '--explain', '--no-cache'], app);
    expect(explained.stdout).toContain(
      `@acme/ui (installed) declares node_modules/@acme/ui/onsystem.config.json, which this project reads under onsystem.config.json`,
    );
  });

  it("applies its rules over the package's, rule by rule, and keeps its overrides to itself", async () => {
    const app = installedApp(
      acmeUi({
        ...INIT_CONFIG,
        rules: { 'no-hardcoded-spacing': 'error', 'no-hardcoded-radius': 'off' },
        overrides: [{ files: ['app/**'], rules: { 'no-unknown-prop': 'off' } }],
      }),
      {
        'onsystem.config.json': json({
          rules: { 'no-hardcoded-spacing': 'warn', 'no-unknown-variant': 'off' },
          overrides: [{ files: ['app/legacy/**'], rules: { 'no-hardcoded-color': 'off' } }],
        }),
      },
    );
    const config = await loadConfig({ root: app });
    expect(config.rules['no-hardcoded-spacing'].severity).toBe('warn');
    expect(config.rules['no-hardcoded-radius'].severity).toBe('off');
    expect(config.rules['no-unknown-variant'].severity).toBe('off');
    expect(config.rules['no-hardcoded-color'].severity).toBe('error');
    expect(config.overrides).toEqual([
      {
        files: ['app/legacy/**'],
        rules: { 'no-hardcoded-color': { severity: 'off', options: {} } },
      },
    ]);
    const { rules } = await check(app);
    expect(rules).toContain('no-unknown-prop');
    expect(rules).not.toContain('no-unknown-variant');
  });

  it("takes none of the package's importPath, docs or elements with components of its own, but keeps its tokens", async () => {
    const pkg = acmeUi({
      ...INIT_CONFIG,
      docs: ['docs/**/*.md'],
      elements: { a: 'Link' },
      libraries: false,
    });
    const own = await loadConfig({
      root: installedApp(pkg, {
        'onsystem.config.json': json({ components: ['components/ui/**/*.tsx'] }),
        'components/ui/button.tsx': BUTTON,
      }),
    });
    expect(own.components).toEqual(['components/ui/**/*.tsx']);
    expect(own.importPath).toBeUndefined();
    expect(own.imports).toEqual([]);
    expect(own.elements).toEqual({});
    expect(own.docs).toEqual(DEFAULT_DOCS);
    expect(own.tokens.map((t) => t.path)).toEqual(['node_modules/@acme/ui/theme.css']);
    expect(own.libraryIds).toBe(false);

    // Without components of its own, the app adds to the package's elements.
    const added = await loadConfig({
      root: installedApp(pkg, { 'onsystem.config.json': json({ elements: { img: 'Image' } }) }),
    });
    expect(added.elements).toEqual({ a: 'Link', img: 'Image' });
    expect(added.docs).toEqual(['node_modules/@acme/ui/docs/**/*.md']);
    expect(added.importPath).toBe('@acme/ui');
  });

  it('is read alone with "extends": false, as an app config was before', async () => {
    const app = installedApp(acmeUi(INIT_CONFIG), {
      'onsystem.config.json': json({ extends: false, rules: { 'no-hardcoded-color': 'warn' } }),
    });
    const config = await loadConfig({ root: app });
    expect(config.designSystemPackage).toBeUndefined();
    expect(config.importPath).toBeUndefined();
    const { code, stderr, rules } = await check(app);
    expect(stderr).toContain('No design system found (no components or color tokens)');
    expect([...rules]).toEqual([]);
    expect(code).toBe(0);
    expect((await run(['inspect', '--no-cache'], app)).stdout).toContain(
      'config   onsystem.config.json\n',
    );
  });

  it("warns, and reads its own config alone, when a workspace package's declaration cannot be read", async () => {
    const root = fixture({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
      'package.json': json({ name: 'acme', private: true }),
      'packages/ui/package.json': json({ name: '@acme/ui', onsystem: './missing.json' }),
      'apps/web/package.json': json({ name: 'web', dependencies: { '@acme/ui': 'workspace:*' } }),
    });
    const app = path.join(root, 'apps/web');
    // With no config of its own, the app cannot be read: the package's team fixes it.
    await expect(loadConfig({ root: app })).rejects.toThrow('names ./missing.json');
    fs.writeFileSync(path.join(app, 'onsystem.config.json'), ONE_RULE);
    const config = await loadConfig({ root: app });
    expect(config.designSystemPackage).toBeUndefined();
    expect(config.warnings?.join('\n')).toContain(
      `So ${path.join(app, 'onsystem.config.json')} is read alone, without the config a design-system package declares. Fix the "onsystem" field in that package, or set "extends": false in onsystem.config.json.`,
    );
  });
});

describe("a workspace root's config, on a design-system package that declares one", () => {
  /** A pnpm monorepo: `@acme/ui` declares a config, and `apps/admin` depends on it. */
  function monorepo(rootConfig: Record<string, unknown>): string {
    const root = fixture({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
      'package.json': json({ name: 'acme', private: true }),
      'onsystem.config.json': json(rootConfig),
      ...at('packages/ui', {
        ...acmeUi({ tokens: ['theme.css'] }),
        'package.json': json({
          name: '@acme/ui',
          version: '1.0.0',
          exports: { '.': './src/index.tsx' },
          onsystem: './onsystem.config.json',
        }),
        'src/index.tsx':
          'export * from "./button";\nexport * from "./card";\nexport * from "./table";\n',
        'src/table.tsx': TABLE,
      }),
      'apps/admin/package.json': json({
        name: 'admin',
        dependencies: { '@acme/ui': 'workspace:*' },
      }),
      'apps/admin/app/page.tsx': 'export default () => <div className="p-[13px]">Page</div>;\n',
      'apps/admin/legacy/old.tsx':
        'export default () => <table><tbody><tr><td>Old</td></tr></tbody></table>;\n',
    });
    fs.mkdirSync(path.join(root, 'apps/admin/node_modules/@acme'), { recursive: true });
    fs.symlinkSync(
      path.join(root, 'packages/ui'),
      path.join(root, 'apps/admin/node_modules/@acme/ui'),
      'junction',
    );
    return root;
  }

  it("applies its rules and overrides over the package's config in checks from the root", async () => {
    const root = monorepo({
      rules: { 'no-hardcoded-spacing': 'off' },
      overrides: [
        { files: ['apps/admin/legacy/**'], rules: { 'prefer-design-system-component': 'off' } },
      ],
    });
    const fromRoot = await check(root);
    expect(fromRoot.findings).toEqual([]);
    expect(fromRoot.code).toBe(0);
    const inspect = await run(['inspect', '--no-cache'], root);
    expect(inspect.stdout).toContain(
      `apps/admin (admin)\n  config     onsystem.config.json, over ${path.join('packages', 'ui', 'onsystem.config.json')} (declared by @acme/ui)\n`,
    );
    expect(inspect.stdout).toContain('components 3 + 0 parts: Button, Card, Table');

    // From the app's folder, as in a CI job per app, the root config is not read.
    const fromApp = await check(path.join(root, 'apps/admin'));
    expect(fromApp.findings).toEqual([
      'app/page.tsx:1 no-hardcoded-spacing warning',
      'legacy/old.tsx:1 prefer-design-system-component error',
    ]);
  });

  it('reads no package config under it with "extends": false', async () => {
    const root = monorepo({ extends: false, rules: { 'no-hardcoded-spacing': 'off' } });
    const { workspace } = await loadTarget({ cwd: root });
    const project = await workspace?.projectFor('apps/admin/app/page.tsx');
    expect(project?.config.designSystemPackage).toBeUndefined();
    expect(project?.config.configFile).toBe(path.join(root, 'onsystem.config.json'));
    expect(project?.config.rules['no-hardcoded-spacing'].severity).toBe('off');
  });

  it('is described by init at the root', async () => {
    const root = monorepo({});
    fs.rmSync(path.join(root, 'onsystem.config.json'));
    const init = await run(['init', '--yes', '--no-cache'], root);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(
      'rules and overrides you add here apply to every project without a config of its own when it is checked from this folder, over the config its design-system package declares.',
    );
  });
});

describe('init in an app on a design-system package', () => {
  it("writes, with --force, a config that builds on the package's", async () => {
    const app = installedApp(acmeUi(INIT_CONFIG));
    const before = await check(app);
    const init = await run(['init', '--yes', '--force', '--no-cache'], app);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(
      `This project reads the config @acme/ui declares (node_modules/@acme/ui/onsystem.config.json). With --force it has one of its own, onsystem.config.json, read over that one: what it leaves out, such as "components", "importPath" and "tokens", still comes from @acme/ui's config, and the rules and overrides you add to it apply over @acme/ui's rules. "extends": false in it reads it alone.`,
    );
    expect(JSON.parse(fs.readFileSync(path.join(app, 'onsystem.config.json'), 'utf8'))).toEqual({
      $schema: 'https://unpkg.com/onsystem/schema.json',
    });
    fs.rmSync(path.join(app, 'onsystem.baseline.json'));
    expect((await check(app)).findings).toEqual(before.findings);
  });
});

describe('init in an app that zero config reads an installed design-system package for', () => {
  /** `@acme/ui` in pnpm's layout: its folder in node_modules/.pnpm, linked from node_modules. */
  function pnpmApp(version: string): string {
    const app = fixture({
      'package.json': json({ name: 'web', dependencies: { '@acme/ui': version } }),
      'app/page.tsx':
        'import { Button } from "@acme/ui";\nexport default () => <Button variant="danger" className="bg-blue-500">Go</Button>;\n',
    });
    install(app, version);
    return app;
  }

  /** Installs `@acme/ui` at `version` as pnpm does, in place of the one installed. */
  function install(app: string, version: string): void {
    const link = path.join(app, 'node_modules/@acme/ui');
    fs.rmSync(link, { force: true, recursive: true });
    fs.rmSync(path.join(app, 'node_modules/.pnpm'), { force: true, recursive: true });
    const dir = path.join(
      app,
      `node_modules/.pnpm/@acme+ui@${version}_react@19.0.0/node_modules/@acme/ui`,
    );
    const files = {
      'package.json': json({
        name: '@acme/ui',
        version,
        files: ['src'],
        exports: { '.': './src/index.tsx', './globals.css': './src/globals.css' },
      }),
      'src/globals.css': '@theme {\n  --color-primary: oklch(0.55 0.2 260);\n}\n',
      'src/index.tsx':
        'export * from "./button";\nexport * from "./card";\nexport * from "./input";\n',
      'src/button.tsx': BUTTON,
      'src/card.tsx': CARD,
      'src/input.tsx': INPUT,
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(dir, link, 'junction');
  }

  it('leaves its components and tokens to zero config, which finds them again after an upgrade', async () => {
    const app = pnpmApp('1.0.0');
    const init = await run(['init', '--yes', '--no-cache'], app);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('Found the design system through installed package @acme/ui.');
    expect(init.stdout).toContain(
      '"components" and "tokens" are left to zero config: they come from a package installed in node_modules, which zero config finds again after each upgrade',
    );
    const written = fs.readFileSync(path.join(app, 'onsystem.config.json'), 'utf8');
    expect(written).not.toContain('node_modules');
    fs.rmSync(path.join(app, 'onsystem.baseline.json'));
    const before = await check(app, 'app/page.tsx');
    expect(before.rules).toEqual(
      new Set(['no-unknown-variant', 'no-unknown-prop', 'no-hardcoded-color']),
    );

    // pnpm puts 1.1.0 in a folder of its own; the config still finds the package.
    install(app, '1.1.0');
    const after = await check(app, 'app/page.tsx');
    expect(after.code).toBe(1);
    expect(after.findings).toEqual(before.findings);
  });
});

describe('init in a design-system package published as dist/', () => {
  const DTS = `import * as react from 'react';
import * as react_jsx_runtime from 'react/jsx-runtime';
declare function Button(props: react.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" }): react_jsx_runtime.JSX.Element;
declare function Card(props: react.HTMLAttributes<HTMLDivElement>): react_jsx_runtime.JSX.Element;
declare function Input(props: react.InputHTMLAttributes<HTMLInputElement>): react_jsx_runtime.JSX.Element;
export { Button, Card, Input };
`;

  /** The package before `init`, with `files` publishing `dist/` and the theme, and `types` or not. */
  function distPackage(types: boolean): Record<string, string> {
    const { 'onsystem.config.json': _, ...sources } = acmeUi({});
    return {
      ...sources,
      'package.json': json({
        name: '@acme/ui',
        version: '1.0.0',
        files: ['dist', 'theme.css'],
        exports: {
          '.': { ...(types ? { types: './dist/index.d.ts' } : {}), import: './dist/index.mjs' },
          './theme.css': './theme.css',
        },
      }),
      ...(types ? { 'dist/index.d.ts': DTS } : {}),
    };
  }

  /** `init --yes` in the package, then an app that installs what npm publishes of it. */
  async function setUp(types: boolean) {
    const pkg = fixture(distPackage(types));
    const init = await run(['init', '--yes', '--no-cache'], pkg);
    expect(init.code).toBe(0);
    const published = ['package.json', 'onsystem.config.json', 'theme.css', 'dist/index.mjs'];
    if (types) published.push('dist/index.d.ts');
    const app = fixture(
      {
        'package.json': json({ name: 'web', dependencies: { '@acme/ui': '1.0.0', react: '19' } }),
        'tsconfig.json': TSCONFIG,
        'app/page.tsx': PAGE,
        ...Object.fromEntries(
          published.map((file) => [
            `node_modules/@acme/ui/${file}`,
            fs.readFileSync(path.join(pkg, file), 'utf8'),
          ]),
        ),
      },
      { nodeModules: true },
    );
    return { init, app };
  }

  it('says that apps read the components from the type declarations it publishes', async () => {
    const { init, app } = await setUp(true);
    expect(init.stdout).toContain(
      'Apps that install @acme/ui from a registry get only what "files" in package.json publishes, which leaves out src/ (3 component files). Those apps read the components from the type declarations it publishes instead (dist/index.d.ts). Add it to "files" for them; workspace apps read the sources either way.',
    );
    expect(init.stdout).toContain(
      'An app that installs @acme/ui from a registry reads its components from the type declarations it publishes, not from src/.',
    );
    const { rules } = await check(app, 'app/page.tsx');
    for (const rule of COMPONENT_RULES) expect(rules).toContain(rule);
    expect((await run(['check', '.', '--require-design-system', '--no-cache'], app)).code).toBe(1);
  });

  it('says that apps get no component checks when it publishes no type declarations', async () => {
    const { init, app } = await setUp(false);
    expect(init.stdout).toContain(
      'which leaves out src/ (3 component files). Those apps do not know the components in it: with no type declarations published either, they get no component, prop, variant or native-element checks, and `onsystem check --require-design-system` fails in them.',
    );
    expect(init.stdout).toContain(
      'An app that installs @acme/ui from a registry gets no component checks until "files" publishes src/.',
    );
    const { rules } = await check(app, 'app/page.tsx');
    for (const rule of COMPONENT_RULES) expect(rules).not.toContain(rule);
    expect((await run(['check', '.', '--require-design-system', '--no-cache'], app)).code).toBe(2);
  });
});
