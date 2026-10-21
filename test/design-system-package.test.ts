import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { DEFAULT_COMPONENTS, DEFAULT_EXCLUDE, loadConfig } from '../src/config.js';
import { DesignSystemHost } from '../src/design-system.js';
import { serveStdio } from '../src/server/stdio.js';
import { silentLogger } from '../src/util/log.js';
import { loadTarget } from '../src/workspace.js';
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
    r.diagnostics.map((d) => `${r.file} ${d.ruleId}: ${d.message}`),
  );
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

/**
 * Laid out like Dub's `@dub/ui`: a published package whose `exports` point at `dist/`, read from
 * the `src/index.tsx` barrel behind it, with `files` listing only `dist`. Its name is not one
 * zero config takes for a design system, so an app finds it only through its declaration.
 */
const KIT = {
  'packages/kit/package.json': json({
    name: '@acme/kit',
    version: '1.0.0',
    files: ['dist/**'],
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } },
  }),
  'packages/kit/src/index.tsx':
    'export * from "./button";\nexport * from "./card";\nexport * from "./input";\n',
  'packages/kit/src/button.tsx':
    'export function Button(props: { variant?: "default" | "outline"; children?: unknown }) { return <button /> }\n',
  'packages/kit/src/card.tsx':
    'export function Card(props: { children?: unknown }) { return <div /> }\n',
  'packages/kit/src/input.tsx':
    'export function Input(props: { value?: string }) { return <input /> }\n',
  'packages/kit/src/globals.css': ':root {\n  --primary: oklch(0.55 0.2 260);\n}\n',
};

const PAGE =
  'import { Button } from "@acme/kit";\nexport default () => <Button variant="danger" className="p-[13px]">Go</Button>;\n';

/** A pnpm monorepo: the kit, and an app that depends on it with no config of its own. */
const MONOREPO = {
  'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
  'package.json': json({ name: 'acme', private: true }),
  ...KIT,
  'apps/web/package.json': json({
    name: '@acme/web',
    dependencies: { '@acme/kit': 'workspace:*' },
  }),
  'apps/web/app/page.tsx': PAGE,
};

/** The kit's sources, at `prefix`: in `packages/kit`, or installed in `node_modules/@acme/kit`. */
function kitAt(prefix: string, config: unknown): Record<string, string> {
  const files: [string, string][] = Object.entries(KIT).map(([file, text]) => [
    file.replace(/^packages\/kit\//, `${prefix}/`),
    file === 'packages/kit/package.json'
      ? json({ ...(JSON.parse(text) as object), onsystem: './onsystem.config.json' })
      : text,
  ]);
  return Object.fromEntries([...files, [`${prefix}/onsystem.config.json`, json(config)]]);
}

describe('init in a design-system package', () => {
  it('sets up every app that depends on it, which then finds it with no config of its own', async () => {
    const root = fixture(MONOREPO);
    const app = path.join(root, 'apps/web');
    const kit = path.join(root, 'packages/kit');

    // Before: @acme/kit is not named like a design system, so the app finds nothing.
    const before = await run(['inspect', '--no-cache'], app);
    expect(before.stdout).toContain('config   (defaults)');
    expect(before.stdout).toContain('files    0 component files');
    expect((await findings(app)).some((f) => f.includes('no-unknown-variant'))).toBe(false);

    // One command in the package.
    const init = await run(['init', '--yes', '--no-cache'], kit);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(
      'This is a design-system package: package.json declares its config ("onsystem": "./onsystem.config.json", also added to "files"), which every app that depends on @acme/kit reads when it has no config of its own.',
    );
    expect(init.stdout).toContain(
      'Apps that install @acme/kit from a registry get only what "files" in package.json publishes, which leaves out src/ (3 component files and 1 token file)',
    );
    expect(init.stdout).toContain('Wrote onsystem.config.json, package.json, ONSYSTEM.md.');
    expect(init.stdout).toContain(
      'A workspace app that depends on @acme/kit now finds it with no config of its own: run `npx onsystem inspect` in one to see it, and give its team ONSYSTEM.md. An app that installs @acme/kit from a registry reads its components from the type declarations it publishes, not from src/.',
    );
    const manifest = read(path.join(kit, 'package.json'));
    expect(manifest.onsystem).toBe('./onsystem.config.json');
    expect(manifest.files).toEqual(['dist/**', 'onsystem.config.json']);
    expect(read(path.join(kit, 'onsystem.config.json'))).toEqual({
      $schema: 'https://unpkg.com/onsystem/schema.json',
      components: ['src/button.tsx', 'src/card.tsx', 'src/input.tsx'],
      importPath: '@acme/kit',
      docs: [
        'docs/components/**/*.{md,mdx}',
        'components/ui/**/*.{md,mdx}',
        'src/components/ui/**/*.{md,mdx}',
        'src/**/*.{md,mdx}',
      ],
      tokens: ['src/globals.css'],
    });
    const guide = fs.readFileSync(path.join(kit, 'ONSYSTEM.md'), 'utf8');
    expect(guide).toMatch(/^# onsystem in apps that use @acme\/kit\n/);
    expect(guide).toContain('/plugin install onsystem@dgesteves');
    expect(guide).toContain('npx skills add dgesteves/onsystem');
    expect(guide).toContain('- run: npx onsystem check . --format github --require-design-system');

    // After: the app takes on the package's config, with its paths from the package.
    const after = await run(['inspect', '--no-cache'], app);
    expect(after.stdout).toContain(
      `config   ${path.join(kit, 'onsystem.config.json')} (declared by @acme/kit)`,
    );
    expect(after.stdout).toContain('files    3 component files, 1 token file');
    expect(await findings(app)).toContain(
      'app/page.tsx no-unknown-variant: "danger" is not a valid variant for <Button>. Allowed: default, outline.',
    );
    const explained = await run(['inspect', '--explain', '--no-cache'], app);
    expect(explained.stdout).toMatch(
      /How the design system was found\n {2}found {2}a design-system package's config: @acme\/kit \(a workspace package\) declares .*onsystem\.config\.json, which this project takes on, with its paths from .*kit\n {2}components come from .*onsystem\.config\.json, so zero config did not look/,
    );

    // Running init in the app writes nothing: it is set up already.
    const appInit = await run(['init', '--yes', '--no-cache'], app);
    expect(appInit.code).toBe(0);
    expect(appInit.stdout).toContain(
      'This project takes on the config @acme/kit declares in its package.json',
    );
    expect(fs.existsSync(path.join(app, 'onsystem.config.json'))).toBe(false);
    expect(appInit.stdout).toContain('Baseline: 2 findings in 1 file → onsystem.baseline.json');
    // --force writes the app a config of its own, which builds on the package's.
    expect((await run(['init', '--yes', '--force', '--no-cache'], app)).code).toBe(0);
    expect(fs.existsSync(path.join(app, 'onsystem.config.json'))).toBe(true);
    const forced = (await run(['inspect', '--no-cache'], app)).stdout;
    expect(forced).toContain(
      `config   onsystem.config.json, over ${path.join(kit, 'onsystem.config.json')} (declared by @acme/kit)\n`,
    );
    expect(forced).toContain('files    3 component files, 1 token file');
  });

  it('keeps package.json as it is written, an ONSYSTEM.md already there, and a private package unnoted', async () => {
    const root = fixture({
      ...MONOREPO,
      'packages/kit/package.json': `{\n\t"name": "@acme/kit",\n\t"private": true,\n\t"files": ["dist", "src"],\n\t"exports": { ".": "./dist/index.mjs" }\n}`,
      'packages/kit/ONSYSTEM.md': 'Ours.\n',
    });
    const kit = path.join(root, 'packages/kit');
    const init = await run(['init', '--yes', '--no-cache'], kit);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(
      'ONSYSTEM.md already exists; it was left as it is (--force replaces it).',
    );
    expect(init.stdout).not.toContain('from a registry');
    expect(fs.readFileSync(path.join(kit, 'ONSYSTEM.md'), 'utf8')).toBe('Ours.\n');
    expect(fs.readFileSync(path.join(kit, 'package.json'), 'utf8')).toBe(
      `{\n\t"name": "@acme/kit",\n\t"private": true,\n\t"files": [\n\t\t"dist",\n\t\t"src",\n\t\t"onsystem.config.json"\n\t],\n\t"exports": {\n\t\t".": "./dist/index.mjs"\n\t},\n\t"onsystem": "./onsystem.config.json"\n}`,
    );
  });

  it('keeps a package config that is already there, and says how to share it', async () => {
    const root = fixture({
      ...MONOREPO,
      'packages/kit/package.json': json({ name: '@acme/ui', files: ['dist'] }),
      'packages/kit/onsystem.config.json': json({ components: ['src/*.tsx'] }),
      'apps/web/onsystem.config.json': json({}),
    });
    const kit = path.join(root, 'packages/kit');
    const init = await run(['init', '--yes', '--no-cache'], kit);
    expect(init.code).toBe(2);
    expect(init.stderr).toContain(
      'To share it with the apps that depend on @acme/ui, add "onsystem": "./onsystem.config.json" to package.json, and to "files" when it lists them',
    );
    expect(read(path.join(kit, 'package.json'))).toEqual({ name: '@acme/ui', files: ['dist'] });
    expect(read(path.join(kit, 'onsystem.config.json'))).toEqual({ components: ['src/*.tsx'] });
    // An app's config is not shared.
    const app = await run(['init', '--yes', '--no-cache'], path.join(root, 'apps/web'));
    expect(app.code).toBe(2);
    expect(app.stderr).not.toContain('To share it');
  });

  it('leaves an app alone: only a package read through its exports or named like one is set up', async () => {
    const root = fixture({
      'package.json': json({ name: 'shop' }),
      'components/ui/button.tsx': 'export function Button() { return <button /> }\n',
    });
    const init = await run(['init', '--yes', '--no-cache'], root);
    expect(init.code).toBe(0);
    expect(read(path.join(root, 'package.json'))).toEqual({ name: 'shop' });
    expect(fs.existsSync(path.join(root, 'ONSYSTEM.md'))).toBe(false);
  });
});

describe('a config a design-system package declares', () => {
  it('is taken on with its paths from the package, keeping its tsconfig, overrides and includeDesignSystem to it', async () => {
    const root = fixture({
      ...MONOREPO,
      ...kitAt('packages/kit', {
        components: ['src/**/*.tsx'],
        exclude: ['src/index.tsx', '**/*.stories.tsx'],
        tokens: ['src/globals.css', 'src/missing.css'],
        docs: ['docs/**/*.md'],
        tsconfig: 'tsconfig.json',
        elements: { a: 'Link' },
        includeDesignSystem: true,
        rules: { 'no-hardcoded-spacing': 'error' },
        overrides: [{ files: ['**/*.tsx'], rules: { 'no-unknown-variant': 'off' } }],
      }),
      'packages/kit/tsconfig.json': json({ compilerOptions: { jsx: 'react-jsx' } }),
    });
    const config = await loadConfig({ root: path.join(root, 'apps/web') });
    expect(config.configFile).toBe(path.join(root, 'packages/kit/onsystem.config.json'));
    expect(config.designSystemPackage).toEqual({
      name: '@acme/kit',
      dir: path.join(root, 'packages/kit'),
      config: path.join(root, 'packages/kit/onsystem.config.json'),
      installed: false,
      boundary: root,
    });
    expect(config.components).toEqual(['../../packages/kit/src/**/*.tsx']);
    // The app keeps the default excludes; the package's own list finds the package's files.
    expect(config.exclude).toEqual([
      ...DEFAULT_EXCLUDE,
      '../../packages/kit/src/index.tsx',
      '**/*.stories.tsx',
    ]);
    expect(config.designSystemExclude).toEqual([
      ...DEFAULT_EXCLUDE,
      '../../packages/kit/src/index.tsx',
      '**/*.stories.tsx',
    ]);
    // A file the package names but does not have is no error in an app: a published package
    // ships only some of its files, and the package's own checks catch a typo.
    expect(config.tokens.map((t) => t.path)).toEqual([
      '../../packages/kit/src/globals.css',
      '../../packages/kit/src/missing.css',
    ]);
    expect(config.docs).toEqual(['../../packages/kit/docs/**/*.md']);
    expect(config.tsconfig).toBeUndefined();
    expect(config.overrides).toEqual([]);
    expect(config.includeDesignSystem).toBe(false);
    expect(config.base).toBeUndefined();
    expect(config.elements).toEqual({ a: 'Link' });
    expect(config.rules['no-hardcoded-spacing'].severity).toBe('error');
    // Imported by the package's exports, through its barrel.
    expect(config.imports).toContainEqual({
      specifier: '@acme/kit',
      target: '../../packages/kit/src/button.tsx',
    });

    const found = await findings(path.join(root, 'apps/web'));
    expect(found).toContain(
      'app/page.tsx no-unknown-variant: "danger" is not a valid variant for <Button>. Allowed: default, outline.',
    );
    // In the package itself, the missing file is an error, and its tsconfig and overrides apply.
    const kit = path.join(root, 'packages/kit');
    await expect(loadConfig({ root: kit })).rejects.toThrow(
      `Token file not found: ${path.join(kit, 'src/missing.css')}`,
    );
    const declared = read(path.join(kit, 'onsystem.config.json'));
    fs.writeFileSync(
      path.join(kit, 'onsystem.config.json'),
      json({ ...declared, tokens: ['src/globals.css'] }),
    );
    const own = await loadConfig({ root: kit });
    expect(own.designSystemPackage).toBeUndefined();
    expect(own.tsconfig).toBe('tsconfig.json');
    expect(own.overrides).toHaveLength(1);
  });

  it('is read from a package installed from a registry, as npm and pnpm lay it out', async () => {
    const config = { tokens: ['src/globals.css'] };
    const npm = fixture({
      'package.json': json({ name: 'shop', dependencies: { '@acme/kit': '^1.0.0' } }),
      ...kitAt('node_modules/@acme/kit', config),
      'app/page.tsx': PAGE,
    });
    expect((await run(['inspect', '--no-cache'], npm)).stdout).toContain(
      'detected installed package @acme/kit',
    );
    expect(await findings(npm)).toContain(
      'app/page.tsx no-unknown-variant: "danger" is not a valid variant for <Button>. Allowed: default, outline.',
    );

    // pnpm links node_modules/@acme/kit to its folder in node_modules/.pnpm. The config names
    // the components, and leaves one out.
    const pnpm = fixture({
      'package.json': json({ name: 'shop', dependencies: { '@acme/kit': '^1.0.0' } }),
      ...kitAt('node_modules/.pnpm/@acme+kit@1.0.0/node_modules/@acme/kit', {
        ...config,
        components: ['src/*.tsx'],
        exclude: ['src/index.tsx', 'src/card.tsx'],
      }),
      'app/page.tsx': PAGE,
    });
    fs.mkdirSync(path.join(pnpm, 'node_modules/@acme'));
    fs.symlinkSync(
      path.join(pnpm, 'node_modules/.pnpm/@acme+kit@1.0.0/node_modules/@acme/kit'),
      path.join(pnpm, 'node_modules/@acme/kit'),
      'junction',
    );
    const loaded = await loadConfig({ root: pnpm });
    expect(loaded.designSystemPackage?.installed).toBe(true);
    expect(loaded.tokens.map((t) => t.path)).toEqual([
      'node_modules/.pnpm/@acme+kit@1.0.0/node_modules/@acme/kit/src/globals.css',
    ]);
    expect((await run(['inspect', '--no-cache'], pnpm)).stdout).toMatch(
      /Components \(2 \+ 0 parts\)\n {2}Button .*\n {2}Input /,
    );
    expect(await findings(pnpm)).toContain(
      'app/page.tsx no-unknown-variant: "danger" is not a valid variant for <Button>. Allowed: default, outline.',
    );
  });

  it("is read under the app's own config, and under a workspace root's from the root", async () => {
    const files = {
      ...MONOREPO,
      ...kitAt('packages/kit', { rules: { 'no-hardcoded-spacing': 'error' } }),
      'onsystem.config.json': json({
        rules: { 'no-hardcoded-spacing': 'off', 'no-unknown-variant': 'off' },
      }),
    };
    const root = fixture(files);
    // From the app's folder, the root's config is not read.
    const fromApp = await loadConfig({ root: path.join(root, 'apps/web') });
    expect(fromApp.designSystemPackage?.name).toBe('@acme/kit');
    expect(fromApp.configFile).toBe(path.join(root, 'packages/kit/onsystem.config.json'));
    expect(fromApp.rules['no-hardcoded-spacing'].severity).toBe('error');
    // From the monorepo root, the app's project reads the root's config over the package's.
    const { workspace } = await loadTarget({ cwd: root });
    const project = await workspace?.projectFor('apps/web/app/page.tsx');
    expect(project?.config.configFile).toBe(path.join(root, 'onsystem.config.json'));
    expect(project?.config.designSystemPackage?.name).toBe('@acme/kit');
    expect(project?.config.components).toEqual(fromApp.components);
    expect(project?.config.rules['no-hardcoded-spacing'].severity).toBe('off');
    const atRoot = await run(['inspect', '--no-cache'], root);
    expect(atRoot.stdout).toContain(
      `apps/web (@acme/web)\n  config     onsystem.config.json, over ${path.join('packages', 'kit', 'onsystem.config.json')} (declared by @acme/kit)`,
    );
    // check from the root reports what check in the app's folder does, but for the rule the
    // root's config turns off.
    const checked = await run(['check', '.', '--format', 'json', '--no-cache'], root);
    const inApp = await findings(path.join(root, 'apps/web'));
    expect(inApp.some((f) => f.includes('no-unknown-variant'))).toBe(true);
    expect(
      (JSON.parse(checked.stdout) as Results)
        .flatMap((r) => r.diagnostics.map((d) => `${r.file} ${d.ruleId}`))
        .filter((f) => f.startsWith('apps/web/')),
    ).toEqual(
      inApp
        .filter((f) => !f.includes('no-unknown-variant'))
        .map((f) => `apps/web/${f}`.replace(/:.*$/, '')),
    );

    // The app's own config builds on the package's, or, with "extends": false, replaces it.
    fs.writeFileSync(path.join(root, 'apps/web/onsystem.config.json'), json({}));
    const own = await loadConfig({ root: path.join(root, 'apps/web') });
    expect(own.designSystemPackage?.name).toBe('@acme/kit');
    expect(own.configFile).toBe(path.join(root, 'apps/web/onsystem.config.json'));
    expect(own.rules['no-hardcoded-spacing'].severity).toBe('error');
    fs.writeFileSync(path.join(root, 'apps/web/onsystem.config.json'), json({ extends: false }));
    const alone = await loadConfig({ root: path.join(root, 'apps/web') });
    expect(alone.designSystemPackage).toBeUndefined();
    expect(alone.rules['no-hardcoded-spacing'].severity).toBe('warn');
  });

  it('is an error when the package names one that cannot be read, a config in code among them', async () => {
    const withField = (onsystem: unknown, extra: Record<string, string> = {}) =>
      fixture({
        ...MONOREPO,
        'packages/kit/package.json': json({
          name: '@acme/kit',
          exports: { '.': './dist/index.mjs' },
          onsystem,
        }),
        ...extra,
      });
    const error = async (root: string) =>
      (await loadConfig({ root: path.join(root, 'apps/web') }).catch((e: unknown) => e)) as Error;
    const missing = await error(withField('./onsystem.config.json'));
    expect(missing.name).toBe('ConfigError');
    expect(missing.message).toMatch(
      /^@acme\/kit: "onsystem" in .*package\.json names \.\/onsystem\.config\.json, which does not exist\.\nFix the "onsystem" field in that package, or give .* a config of its own \(onsystem\.config\.json\), which is read instead\.$/,
    );
    const code = await error(
      withField('./onsystem.config.mjs', {
        'packages/kit/onsystem.config.mjs': 'throw new Error("ran");\n',
      }),
    );
    expect(code.message).toContain(
      'is "./onsystem.config.mjs": it names a JSON config file in the package, such as "./onsystem.config.json".',
    );
    const outside = await error(
      withField('../../onsystem.config.json', { 'onsystem.config.json': json({}) }),
    );
    expect(outside.message).toContain(
      'names ../../onsystem.config.json, which is outside the package.',
    );
  });

  it('is skipped with one warning when an installed package names one that cannot be read', async () => {
    const root = fixture({
      'package.json': json({
        name: 'shop',
        dependencies: { '@acme/kit': '^1.0.0', 'left-pad': '^1.0.0' },
      }),
      'tsconfig.json': json({ compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./*'] } } }),
      // A published package that names a config it does not publish, and another use of the field.
      'node_modules/@acme/kit/package.json': json({
        name: '@acme/kit',
        files: ['dist'],
        onsystem: './onsystem.config.json',
      }),
      'node_modules/left-pad/package.json': json({ name: 'left-pad', onsystem: { other: 'use' } }),
      'components/ui/button.tsx': KIT['packages/kit/src/button.tsx'],
      'app/page.tsx':
        'import { Button } from "@/components/ui/button";\nexport default () => <Button variant="danger" />;\n',
    });
    const config = await loadConfig({ root });
    // Read as if no dependency declared one: zero config finds the app's components/ui.
    expect(config.configFile).toBeUndefined();
    expect(config.designSystemPackage).toBeUndefined();
    expect(config.components).toEqual(DEFAULT_COMPONENTS);
    expect(config.warnings).toEqual([
      `@acme/kit's onsystem config was skipped: "onsystem" in ${path.join(root, 'node_modules/@acme/kit/package.json')} names ./onsystem.config.json, which does not exist. @acme/kit is installed in node_modules, so this project is read as if it declared none.`,
      `left-pad's onsystem config was skipped: "onsystem" in ${path.join(root, 'node_modules/left-pad/package.json')} is {"other":"use"}: it names a JSON config file in the package, such as "./onsystem.config.json". left-pad is installed in node_modules, so this project is read as if it declared none.`,
    ]);

    // check says each once, and checks the app as zero config does.
    const checked = await run(['check', '.', '--format', 'json', '--no-cache'], root);
    expect(checked.code).toBe(1);
    expect(checked.stderr.split('\n').filter((line) => line.includes('was skipped'))).toEqual(
      config.warnings,
    );
    expect(await findings(root)).toContain(
      'app/page.tsx no-unknown-variant: "danger" is not a valid variant for <Button>. Allowed: default, outline.',
    );
    const explained = await run(['inspect', '--explain', '--no-cache'], root);
    expect(explained.stdout).toContain(
      'no dependency declares one ("onsystem" in its package.json) among 2 dependencies; @acme/kit, left-pad declare one that cannot be read, skipped since installed',
    );

    // The MCP server logs them once, and serves the app's components.
    const warned: string[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await serveStdio({
      cwd: root,
      cache: false,
      watch: false,
      logger: { ...silentLogger, warn: (text) => warned.push(text) },
      transport: serverTransport,
    });
    const client = new Client({ name: 'package-test', version: '1.0.0' });
    await client.connect(clientTransport);
    const button = await client.callTool({ name: 'get_component', arguments: { name: 'Button' } });
    expect((button as CallToolResult).isError).toBeFalsy();
    expect(warned.filter((text) => text.includes('was skipped'))).toEqual(config.warnings);
    await client.close();
    await server.close();

    // A workspace package with the same problem is still an error: its team owns it.
    const workspace = fixture({
      ...MONOREPO,
      'packages/kit/package.json': json({ name: '@acme/kit', onsystem: './onsystem.config.json' }),
    });
    await expect(loadConfig({ root: path.join(workspace, 'apps/web') })).rejects.toThrow(
      /^@acme\/kit: "onsystem" in .*package\.json names \.\/onsystem\.config\.json, which does not exist\./,
    );
  });

  it("adds a package's exclude to the app's defaults, which keep its tests and stories out", async () => {
    const root = fixture({
      ...MONOREPO,
      ...kitAt('packages/kit', {
        components: ['src/**/*.tsx'],
        exclude: ['src/index.tsx', 'src/legacy/**'],
      }),
      'packages/kit/src/legacy/old-button.tsx':
        'export function OldButton(props: { children?: unknown }) { return <button /> }\n',
      'apps/web/app/page.stories.tsx': PAGE,
      'apps/web/app/__tests__/page.tsx': PAGE,
    });
    const app = path.join(root, 'apps/web');
    const config = await loadConfig({ root: app });
    const own = ['../../packages/kit/src/index.tsx', '../../packages/kit/src/legacy/**'];
    expect(config.exclude).toEqual([...DEFAULT_EXCLUDE, ...own]);
    // The package's files are found with its own list, which adds to the defaults, as the
    // package finds them.
    expect(config.designSystemExclude).toEqual([...DEFAULT_EXCLUDE, ...own]);
    expect((await run(['inspect', '--no-cache'], app)).stdout).toMatch(
      /Components \(3 \+ 0 parts\)\n {2}Button .*\n {2}Card .*\n {2}Input /,
    );
    // The app's story and test stay out, from its folder and from the monorepo root.
    const files = (found: string[]) => [...new Set(found.map((f) => f.split(' ')[0]))];
    expect(files(await findings(app))).toEqual(['app/page.tsx']);
    expect(files(await findings(root))).toEqual(['apps/web/app/page.tsx']);
  });

  it("ignores paths that leave an installed package, or a workspace package's workspace, with one warning", async () => {
    const outside = {
      'outside/notes.md': '# Button\n\nNot from the package.\n',
      'outside/theme.css': ':root {\n  --leak: #abcdef;\n}\n',
    };
    // Installed: only the package's own folder.
    const shop = fixture({
      ...outside,
      'shop/package.json': json({ name: 'shop', dependencies: { '@acme/kit': '^1.0.0' } }),
      ...kitAt('shop/node_modules/@acme/kit', {
        tokens: ['src/globals.css', '../../../../outside/theme.css'],
        docs: ['../../../../outside/*.md', '{src,../../../../outside}/**/*.md', '/etc/*.md'],
      }),
      'shop/app/page.tsx': PAGE,
    });
    const app = path.join(shop, 'shop');
    const installed = await loadConfig({ root: app });
    expect(installed.tokens.map((t) => t.path)).toEqual(['node_modules/@acme/kit/src/globals.css']);
    expect(installed.docs).toEqual([]);
    expect(installed.warnings).toEqual([
      "@acme/kit's onsystem config names paths outside the package, which were ignored: tokens ../../../../outside/theme.css, docs ../../../../outside/*.md, docs {src,../../../../outside}/**/*.md, docs /etc/*.md.",
    ]);
    const model = (await run(['inspect', '--format', 'json', '--no-cache'], app)).stdout;
    expect(model).toContain('--primary');
    expect(model).not.toContain('--leak');
    expect(model).not.toContain('Not from the package');

    // A workspace package: anywhere in the workspace (a sibling package's tokens), not outside it.
    const repo = fixture({
      ...outside,
      ...Object.fromEntries(Object.entries(MONOREPO).map(([file, text]) => [`repo/${file}`, text])),
      ...kitAt('repo/packages/kit', {
        tokens: ['../tokens/theme.css', '../../../outside/theme.css'],
        docs: ['../../../outside/*.md'],
      }),
      'repo/packages/tokens/package.json': json({ name: '@acme/tokens' }),
      'repo/packages/tokens/theme.css': ':root {\n  --brand: #123456;\n}\n',
    });
    const workspace = await loadConfig({ root: path.join(repo, 'repo/apps/web') });
    expect(workspace.designSystemPackage?.boundary).toBe(path.join(repo, 'repo'));
    expect(workspace.tokens.map((t) => t.path)).toEqual(['../../packages/tokens/theme.css']);
    expect(workspace.docs).toEqual([]);
    expect(workspace.warnings).toEqual([
      "@acme/kit's onsystem config names paths outside the workspace, which were ignored: tokens ../../../outside/theme.css, docs ../../../outside/*.md.",
    ]);
  });

  it('finds a workspace package added or declared after a load, in the same process', async () => {
    const root = fixture({
      ...MONOREPO,
      'apps/web/package.json': json({
        name: '@acme/web',
        dependencies: { '@acme/kit': 'workspace:*', '@acme/brand': 'workspace:*' },
      }),
    });
    const app = path.join(root, 'apps/web');
    expect((await loadConfig({ root: app })).designSystemPackage).toBeUndefined();
    // A package added to packages/ is found: the workspace is read again.
    fs.mkdirSync(path.join(root, 'packages/brand'));
    fs.writeFileSync(
      path.join(root, 'packages/brand/package.json'),
      json({ name: '@acme/brand', onsystem: './onsystem.config.json' }),
    );
    fs.writeFileSync(path.join(root, 'packages/brand/onsystem.config.json'), json({}));
    expect((await loadConfig({ root: app })).designSystemPackage?.name).toBe('@acme/brand');
    // So is a declaration added to a package already read.
    fs.rmSync(path.join(root, 'packages/brand'), { recursive: true });
    const kit = read(path.join(root, 'packages/kit/package.json'));
    fs.writeFileSync(
      path.join(root, 'packages/kit/package.json'),
      json({ ...kit, onsystem: './onsystem.config.json' }),
    );
    fs.writeFileSync(path.join(root, 'packages/kit/onsystem.config.json'), json({}));
    expect((await loadConfig({ root: app })).designSystemPackage?.name).toBe('@acme/kit');
  });

  it('comes from the package the code imports most when several declare one', async () => {
    const root = fixture({
      ...MONOREPO,
      ...kitAt('packages/kit', {}),
      'packages/icons/package.json': json({
        name: '@acme/icons',
        onsystem: './onsystem.config.json',
      }),
      'packages/icons/onsystem.config.json': json({}),
      'apps/web/package.json': json({
        name: '@acme/web',
        dependencies: { '@acme/icons': 'workspace:*', '@acme/kit': 'workspace:*' },
      }),
    });
    const config = await loadConfig({ root: path.join(root, 'apps/web') });
    expect(config.designSystemPackage?.name).toBe('@acme/kit');
    const explained = await run(
      ['inspect', '--explain', '--no-cache'],
      path.join(root, 'apps/web'),
    );
    expect(explained.stdout).toContain(
      '@acme/icons also declare one, not read: one config is taken on, from the package the code imports most',
    );
  });

  it('is served by the MCP server started in the app', async () => {
    const root = fixture({ ...MONOREPO, ...kitAt('packages/kit', {}) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await serveStdio({
      cwd: path.join(root, 'apps/web'),
      cache: false,
      watch: false,
      logger: silentLogger,
      transport: serverTransport,
    });
    const client = new Client({ name: 'package-test', version: '1.0.0' });
    await client.connect(clientTransport);
    const text = (result: unknown) => {
      const content = (result as CallToolResult).content[0];
      return content?.type === 'text' ? content.text : '';
    };
    const button = await client.callTool({ name: 'get_component', arguments: { name: 'Button' } });
    expect(text(button)).toContain('import { Button } from "@acme/kit"');
    expect(text(button)).toContain('variant?: "default" | "outline"');
    const tokens = await client.callTool({ name: 'get_tokens', arguments: {} });
    expect(text(tokens)).toContain('--primary');
    const checked = await client.callTool({
      name: 'check_ui',
      arguments: { path: 'app/page.tsx' },
    });
    expect(text(checked)).toContain(
      '"danger" is not a valid variant for <Button>. Allowed: default, outline.',
    );
    await client.close();
    await server.close();
  });

  it('is read again when it changes, still from the package', async () => {
    const root = fixture({ ...MONOREPO, ...kitAt('packages/kit', {}) });
    const host = new DesignSystemHost(await loadConfig({ root: path.join(root, 'apps/web') }), {
      cache: false,
    });
    await host.get();
    const changed = new Promise<string[]>((resolve) => {
      host.onChange((ds) => {
        if (ds.config.rules['no-hardcoded-spacing'].severity === 'error') {
          resolve(ds.components.map((c) => c.name).sort());
        }
      });
    });
    host.watch();
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(
      path.join(root, 'packages/kit/onsystem.config.json'),
      json({ rules: { 'no-hardcoded-spacing': 'error' } }),
    );
    await expect(changed).resolves.toEqual(['Button', 'Card', 'Input']);
    host.close();
  }, 15_000);
});
