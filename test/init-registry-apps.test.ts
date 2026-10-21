import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { fixture } from './helpers.js';

const json = (value: unknown) => JSON.stringify(value, null, 2);

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, color: false, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await main(args, io);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

type Results = { file: string; diagnostics: { ruleId: string; message: string }[] }[];

async function findings(cwd: string): Promise<string[]> {
  const { stdout } = await run(['check', '.', '--format', 'json', '--no-cache'], cwd);
  return (JSON.parse(stdout) as Results).flatMap((r) =>
    r.diagnostics.map((d) => `${d.ruleId}: ${d.message}`),
  );
}

const read = (file: string) => fs.readFileSync(file, 'utf8');

const BUTTON =
  'export function Button(props: { variant?: "default" | "outline"; children?: unknown }) { return <button /> }\n';
const CARD = 'export function Card(props: { children?: unknown }) { return <div /> }\n';
const INPUT = 'export function Input(props: { value?: string }) { return <input /> }\n';
const THEME = ':root {\n  --primary: oklch(0.55 0.2 260);\n  --radius: 0.5rem;\n}\n';

/**
 * A design-system package like @northwind/ui: exports built `dist/`, with its type declarations
 * unless `types` is false, and sources in `src/`.
 */
function northwind(files: string[], types = true): Record<string, string> {
  return {
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'package.json': json({ name: 'northwind', private: true }),
    'packages/ui/package.json': json({
      name: '@northwind/ui',
      version: '1.0.0',
      files,
      exports: {
        '.': { ...(types ? { types: './dist/index.d.ts' } : {}), import: './dist/index.mjs' },
        './theme.css': './theme.css',
      },
    }),
    'packages/ui/src/index.tsx':
      'export * from "./button";\nexport * from "./card";\nexport * from "./input";\n',
    'packages/ui/src/button.tsx': BUTTON,
    'packages/ui/src/card.tsx': CARD,
    'packages/ui/src/input.tsx': INPUT,
    'packages/ui/theme.css': THEME,
  };
}

/** An app that installs the package from a registry: `node_modules` holds what it published. */
function installed(pkg: string, name: string, published: string[]): string {
  const app = fixture({
    'package.json': json({ name: 'shop', dependencies: { [name]: '^1.0.0' } }),
    'app/page.tsx': `import { Button } from "${name}";\nexport default () => <Button variant="danger" className="bg-[#ff0000]">Go</Button>;\n`,
  });
  for (const file of published) {
    const to = path.join(app, 'node_modules', name, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(pkg, file), to);
  }
  return app;
}

describe('init in a design-system package tells its team what installed apps get', () => {
  it('names the component files "files" leaves out, and what apps lose without them', async () => {
    // With no type declarations to read them from either (test/layered-config.test.ts has the
    // package that publishes them).
    const root = fixture(northwind(['dist', 'theme.css'], false));
    const ui = path.join(root, 'packages/ui');

    const init = await run(['init', '--yes', '--no-cache'], ui);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(
      'Apps that install @northwind/ui from a registry get only what "files" in package.json publishes, which leaves out src/ (3 component files). Those apps do not know the components in it: with no type declarations published either, they get no component, prop, variant or native-element checks, and `onsystem check --require-design-system` fails in them. Add it to "files" for them; workspace apps read the sources either way.',
    );
    const next = init.stdout.split('\n').find((line) => line.startsWith('Next:'));
    expect(next).toBe(
      'Next: commit onsystem.config.json, package.json and ONSYSTEM.md. A workspace app that depends on @northwind/ui now finds it with no config of its own: run `npx onsystem inspect` in one to see it, and give its team ONSYSTEM.md. An app that installs @northwind/ui from a registry gets no component checks until "files" publishes src/.',
    );
    // What it publishes is the team's call: only the config is added.
    expect(JSON.parse(read(path.join(ui, 'package.json')))).toMatchObject({
      files: ['dist', 'theme.css', 'onsystem.config.json'],
    });

    // What it says is what such an app gets: the token rules, and no component.
    const app = installed(ui, '@northwind/ui', [
      'package.json',
      'onsystem.config.json',
      'theme.css',
    ]);
    const found = await findings(app);
    expect(found.some((f) => f.startsWith('no-hardcoded-color:'))).toBe(true);
    expect(found.some((f) => f.startsWith('no-unknown-variant:'))).toBe(false);
    const required = await run(['check', '.', '--require-design-system', '--no-cache'], app);
    expect(required.code).toBe(2);
    expect(required.stderr).toContain('No design-system components found');
  });

  it('counts token files apart, and says only what is lost when the components ship', async () => {
    const root = fixture(northwind(['dist', 'src']));
    const ui = path.join(root, 'packages/ui');

    const init = await run(['init', '--yes', '--no-cache'], ui);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(
      'which leaves out theme.css (1 token file). Those apps do not know the tokens in it. Add it to "files" for them;',
    );
    expect(init.stdout).not.toContain('no component, prop, variant');
    expect(init.stdout).toContain(
      'An app that installs @northwind/ui from a registry does not read theme.css.',
    );
  });

  /** Tokens in a sibling package the design system imports, as main's init finds them. */
  const SIBLING = {
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'package.json': json({ name: 'acme', private: true }),
    'packages/tailwind-config/package.json': json({
      name: '@acme/tailwind-config',
      version: '1.0.0',
      files: ['theme.css'],
      exports: { './theme.css': './theme.css' },
    }),
    'packages/tailwind-config/theme.css':
      ':root {\n  --primary: oklch(0.55 0.2 260);\n  --destructive: oklch(0.6 0.2 25);\n}\n',
    'packages/ui/package.json': json({
      name: '@acme/ui',
      version: '1.0.0',
      files: ['src'],
      exports: { '.': './src/index.tsx', './styles.css': './src/styles.css' },
      dependencies: { '@acme/tailwind-config': 'workspace:*' },
    }),
    'packages/ui/src/index.tsx':
      'export * from "./button";\nexport * from "./card";\nexport * from "./input";\n',
    'packages/ui/src/button.tsx': BUTTON,
    'packages/ui/src/card.tsx': CARD,
    'packages/ui/src/input.tsx': INPUT,
    'packages/ui/src/styles.css':
      '@import "@acme/tailwind-config/theme.css";\n:root {\n  --radius: 0.5rem;\n}\n',
  };

  it('warns that a token file outside the package is not read where it is installed', async () => {
    const root = fixture(SIBLING);
    const ui = path.join(root, 'packages/ui');

    const init = await run(['init', '--yes', '--no-cache'], ui);
    expect(init.code).toBe(0);
    expect(JSON.parse(read(path.join(ui, 'onsystem.config.json')))).toMatchObject({
      tokens: ['src/styles.css', '../tailwind-config/theme.css'],
    });
    expect(init.stdout).toContain(
      'Apps that install @acme/ui from a registry read only the files in it, so they skip ../tailwind-config/theme.css, outside the package (1 token file). Those apps do not know the tokens in it. Workspace apps read it. To give installed apps what it holds, keep a copy in the package, publish it, and name the copy in the config instead.',
    );
    expect(init.stdout).toContain(
      'An app that installs @acme/ui from a registry does not read ../tailwind-config/theme.css.',
    );
    expect(init.stdout).not.toContain('"files" in package.json publishes');

    // Installed with its sibling, the app skips the path, and with it every color token.
    const app = installed(ui, '@acme/ui', [
      'package.json',
      'onsystem.config.json',
      'src/index.tsx',
      'src/button.tsx',
      'src/card.tsx',
      'src/input.tsx',
      'src/styles.css',
    ]);
    const sibling = path.join(app, 'node_modules/@acme/tailwind-config');
    fs.mkdirSync(sibling, { recursive: true });
    fs.copyFileSync(path.join(root, 'packages/tailwind-config/theme.css'), `${sibling}/theme.css`);
    fs.copyFileSync(
      path.join(root, 'packages/tailwind-config/package.json'),
      `${sibling}/package.json`,
    );
    expect((await loadConfig({ root: app })).warnings).toContain(
      "@acme/ui's onsystem config names paths outside the package, which were ignored: tokens ../tailwind-config/theme.css.",
    );
    expect((await run(['check', '.', '--no-cache'], app)).stdout).toContain(
      'No color tokens found: no-hardcoded-color did not run.',
    );
  });

  it('says nothing about registries for a private package, and warns without a "files" list', async () => {
    const manifest = JSON.parse(SIBLING['packages/ui/package.json']) as Record<string, unknown>;
    const quiet = fixture({
      ...SIBLING,
      'packages/ui/package.json': json({ ...manifest, private: true }),
    });
    const init = await run(['init', '--yes', '--no-cache'], path.join(quiet, 'packages/ui'));
    expect(init.code).toBe(0);
    expect(init.stdout).not.toContain('from a registry');
    expect(init.stdout).toContain('An app that depends on @acme/ui now finds it');

    const { files: _files, ...unlisted } = manifest;
    const everything = fixture({ ...SIBLING, 'packages/ui/package.json': json(unlisted) });
    expect(
      (await run(['init', '--yes', '--no-cache'], path.join(everything, 'packages/ui'))).stdout,
    ).toContain('so they skip ../tailwind-config/theme.css, outside the package (1 token file).');
  });
});

describe('init --force in an app that takes on a design-system package config', () => {
  const PACKAGE = {
    'node_modules/@acme/kit/package.json': json({
      name: '@acme/kit',
      version: '1.0.0',
      exports: { '.': './src/index.tsx' },
      onsystem: './onsystem.config.json',
    }),
    'node_modules/@acme/kit/src/index.tsx': 'export * from "./button";\nexport * from "./card";\n',
    'node_modules/@acme/kit/src/button.tsx': BUTTON,
    'node_modules/@acme/kit/src/card.tsx': CARD,
    'node_modules/@acme/kit/theme.css': THEME,
    'package.json': json({ name: 'shop', dependencies: { '@acme/kit': '^1.0.0' } }),
    'app/page.tsx':
      'import { Button } from "@acme/kit";\nexport default () => <Button variant="danger">Go</Button>;\n',
  };
  const VARIANT =
    'no-unknown-variant: "danger" is not a valid variant for <Button>. Allowed: default, outline.';

  it("writes a config that builds on the package's, keeping its components, importPath, tokens and rules", async () => {
    const app = fixture({
      ...PACKAGE,
      'node_modules/@acme/kit/onsystem.config.json': json({
        components: ['src/*.tsx'],
        exclude: ['src/index.tsx'],
        importPath: '@acme/kit',
        tokens: ['theme.css'],
        rules: { 'no-hardcoded-spacing': 'error' },
      }),
    });
    expect(await findings(app)).toContain(VARIANT);

    const init = await run(['init', '--yes', '--force', '--no-cache'], app);
    expect(init.code).toBe(0);
    expect(init.stdout).not.toContain('default folders');
    expect(init.stdout).toContain(
      `This project reads the config @acme/kit declares (node_modules/@acme/kit/onsystem.config.json). With --force it has one of its own, onsystem.config.json, read over that one:`,
    );
    expect(JSON.parse(read(path.join(app, 'onsystem.config.json')))).toEqual({
      $schema: 'https://unpkg.com/onsystem/schema.json',
    });
    // The app's own config still checks the package's components where they are imported.
    fs.rmSync(path.join(app, 'onsystem.baseline.json'));
    expect(await findings(app)).toContain(VARIANT);
    const config = await loadConfig({ root: app });
    expect(config.components).toEqual(['node_modules/@acme/kit/src/*.tsx']);
    expect(config.importPath).toBe('@acme/kit');
    expect(config.tokens.map((t) => t.path)).toEqual(['node_modules/@acme/kit/theme.css']);
    expect(config.rules['no-hardcoded-spacing'].severity).toBe('error');
  });

  it("keeps the components zero config reads through the package's config, which a copy could not name", async () => {
    // The package's config leaves its components to zero config, which reads an installed
    // package named otherwise only through a config it declares.
    const app = fixture({
      ...PACKAGE,
      'node_modules/@acme/kit/package.json': json({
        name: '@acme/kit',
        version: '1.0.0',
        exports: {
          './button': './src/button.tsx',
          './card': './src/card.tsx',
          './input': './src/input.tsx',
        },
        onsystem: './onsystem.config.json',
      }),
      'node_modules/@acme/kit/src/input.tsx': INPUT,
      'node_modules/@acme/kit/onsystem.config.json': json({ tokens: ['theme.css'] }),
      'app/page.tsx':
        'import { Button } from "@acme/kit/button";\nexport default () => <Button variant="danger">Go</Button>;\n',
    });
    expect(await findings(app)).toContain(VARIANT);

    const init = await run(['init', '--yes', '--force', '--no-cache'], app);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(
      "still comes from @acme/kit's config, and the rules and overrides you add to it apply over @acme/kit's rules.",
    );
    fs.rmSync(path.join(app, 'onsystem.baseline.json'), { force: true });
    expect(await findings(app)).toContain(VARIANT);
  });
});
