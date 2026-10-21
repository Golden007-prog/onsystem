import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { fixture, load } from './helpers.js';

// TypeScript's parser is recursive: one component file nested thousands of levels deep used to
// fail the whole design system with "Maximum call stack size exceeded", naming no file, in every
// MCP tool, `inspect` and `check`. And any crash exited 1, the code for "there are findings",
// which docs/ci.md's SARIF step lets through.

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, color: false, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await main(args, io);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const DEPTH = 10_000;
const DEEP = `export function Deep() {\n  return (\n${'<div>'.repeat(DEPTH)}x${'</div>'.repeat(DEPTH)}\n  );\n}\n`;

const project = (deep = true) =>
  fixture({
    'onsystem.config.json': JSON.stringify({
      components: ['components/**/*.tsx'],
      tokens: ['app/globals.css'],
    }),
    'components/ui/button.tsx':
      '/** Runs an action. */\nexport function Button(props: { tone?: "calm" | "loud" }) { return <button /> }\n',
    ...(deep ? { 'components/ui/deep.tsx': DEEP } : {}),
    'app/globals.css': '@theme { --color-primary: #2563eb; }\n',
    'app/page.tsx': 'export default () => <button className="bg-[#2563eb]">Go</button>;\n',
  });

describe('a component file nested too deeply to parse', () => {
  it('is skipped with a warning that names it, and the rest of the design system loads', async () => {
    const ds = await load(project());
    expect(ds.components.map((c) => c.name)).toEqual(['Button']);
    expect(ds.model.warnings).toContain(
      'components/ui/deep.tsx: nested too deeply to read (thousands of levels); skipped.',
    );
  });

  it('leaves inspect and check working', async () => {
    const root = project();
    const inspected = await run(['inspect', '--no-cache'], root);
    expect(inspected.code).toBe(0);
    expect(inspected.stdout).toContain('components/ui/deep.tsx: nested too deeply to read');
    const checked = await run(['check', 'app', '--no-cache'], root);
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain('Hardcoded color');
  });
});

describe('a crash', () => {
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'exits 2, not 1, with the error on stderr',
    async () => {
      const root = project(false);
      const locked = path.join(root, 'app/locked.tsx');
      fs.writeFileSync(locked, 'export default () => <p>Hi</p>;\n');
      fs.chmodSync(locked, 0o000);
      try {
        for (const format of ['pretty', 'sarif']) {
          const { code, stderr } = await run(
            ['check', 'app', '--no-cache', '--format', format],
            root,
          );
          expect(code).toBe(2);
          expect(stderr).toContain('EACCES');
        }
      } finally {
        fs.chmodSync(locked, 0o644);
      }
    },
  );
});
