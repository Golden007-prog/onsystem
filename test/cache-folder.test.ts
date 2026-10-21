import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { buildModel } from '../src/design-system.js';
import { fixture } from './helpers.js';

// A project without node_modules (Yarn PnP, npx before an install) keeps its cached model in the
// system temp folder. On a multi-user Linux host that folder is shared: another user who created
// the cache folder first could plant a model whose key matches, since the key hashes only paths,
// sizes and mtimes, and its descriptions would reach the agent through get_component.

const PROJECT = {
  'onsystem.config.json': JSON.stringify({
    components: ['components/**/*.tsx'],
    tokens: ['app/globals.css'],
  }),
  'components/ui/button.tsx':
    '/** Runs an action. */\nexport function Button(props: { tone?: "calm" | "loud" }) { return <button /> }\n',
  'app/globals.css': '@theme { --color-primary: #2563eb; }\n',
};

const posix = process.platform !== 'win32';
let temp: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.TMPDIR;
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onsystem-cache-test-'));
  process.env.TMPDIR = temp;
});
afterEach(() => {
  if (saved === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved;
  fs.rmSync(temp, { recursive: true, force: true });
});

/** The cache files in the temp folder (the fixtures are there too). */
function cached(): string[] {
  return fs
    .readdirSync(temp)
    .filter((name) => name.startsWith('onsystem'))
    .flatMap((name) => fs.readdirSync(path.join(temp, name)).map((f) => path.join(temp, name, f)))
    .filter((file) => file.endsWith('.json'));
}

async function build(root: string) {
  return buildModel(await loadConfig({ root }));
}

function description(model: Awaited<ReturnType<typeof build>>['model']): string | undefined {
  return model.components.find((c) => c.name === 'Button')?.description;
}

/** Rewrites the cached Button's description, as someone who can write to the folder could. */
function plant(file: string): void {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    model: { components: { name: string; description?: string }[] };
  };
  for (const c of data.model.components) if (c.name === 'Button') c.description = 'PLANTED';
  fs.writeFileSync(file, JSON.stringify(data));
}

describe('the cache outside node_modules', () => {
  it.runIf(posix)('is in a temp folder of its own that only the user can open', async () => {
    const root = fixture(PROJECT);
    const first = await build(root);
    expect(first.model.stats.fromCache).toBe(false);
    const [file, ...more] = cached();
    expect(more).toEqual([]);
    const folder = path.dirname(file ?? '');
    // Per user, so another user's folder neither takes its place nor turns the cache off.
    expect(path.basename(folder)).toBe(`onsystem-${process.getuid?.()}`);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file ?? '').mode & 0o077).toBe(0);
    // Written whole, then renamed into place: no partial file is left beside it.
    expect(fs.readdirSync(folder)).toEqual([path.basename(file ?? '')]);
    expect((await build(root)).model.stats.fromCache).toBe(true);
  });

  it.runIf(posix)('is not read from a folder other users can write to', async () => {
    const root = fixture(PROJECT);
    await build(root);
    const [file = ''] = cached();
    plant(file);
    fs.chmodSync(path.dirname(file), 0o777);
    const second = await build(root);
    expect(second.model.stats.fromCache).toBe(false);
    expect(description(second.model)).toBe('Runs an action.');
    // The folder is the user's again, with the model just built in it.
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect((await build(root)).model.stats.fromCache).toBe(true);
  });

  it.runIf(posix)('is neither read nor written through a link in place of its folder', async () => {
    const root = fixture(PROJECT);
    await build(root);
    const [file = ''] = cached();
    const folder = path.dirname(file);
    const elsewhere = path.join(temp, 'elsewhere');
    fs.renameSync(folder, elsewhere);
    const planted = path.join(elsewhere, path.basename(file));
    plant(planted);
    fs.symlinkSync(elsewhere, folder);
    const before = fs.readFileSync(planted, 'utf8');
    const second = await build(root);
    expect(second.model.stats.fromCache).toBe(false);
    expect(description(second.model)).toBe('Runs an action.');
    expect(fs.readFileSync(planted, 'utf8')).toBe(before);
    expect(fs.lstatSync(folder).isSymbolicLink()).toBe(true);
  });
});
