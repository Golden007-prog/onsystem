import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { DesignSystem } from '../src/design-system.js';
import { DEMO_ROOT, loadOnce } from './helpers.js';

// One className with thousands of color classes made no-hardcoded-color quadratic: each finding
// read the whole class string again for its scopes, and compared its class with every other one
// in the list. A 200 KB class list took 38 s in the MCP server, which answers nothing else
// meanwhile. And each finding quoted its class whole: 33,000 `hover:` variants made one message of
// 400,000 characters.

const work = vi.hoisted(() => ({ distances: 0, scanned: 0 }));

vi.mock('../src/tokens/color.js', async (importOriginal) => {
  const color = await importOriginal<typeof import('../src/tokens/color.js')>();
  return {
    ...color,
    colorDistance: (...args: Parameters<typeof color.colorDistance>) => {
      work.distances++;
      return color.colorDistance(...args);
    },
  };
});

vi.mock('../src/tokens/roles.js', async (importOriginal) => {
  const roles = await importOriginal<typeof import('../src/tokens/roles.js')>();
  return {
    ...roles,
    scopesIn: (...args: Parameters<typeof roles.scopesIn>) => {
      const [, ...texts] = args;
      for (const text of texts) work.scanned += text?.length ?? 0;
      return roles.scopesIn(...args);
    },
  };
});

let ds: DesignSystem;
beforeAll(async () => {
  ds = await loadOnce(DEMO_ROOT);
});

/** The work a check of one className of `n` classes takes, and its findings. */
function check(n: number, cls: (i: number) => string) {
  const classes = Array.from({ length: n }, (_, i) => cls(i)).join(' ');
  work.distances = 0;
  work.scanned = 0;
  const result = ds.check(`export const A = () => <div className="${classes}" />\n`, 'app/a.tsx');
  return { ...work, findings: result.diagnostics.length };
}

const hex = (i: number) => `#${((i * 2654435761) % 0xffffff).toString(16).padStart(6, '0')}`;

describe('no-hardcoded-color on one long class list', () => {
  for (const [what, cls] of [
    ['one color, again and again', () => 'bg-[#ff0000]'],
    ['a color and a length each time', (i: number) => (i % 2 ? 'p-[13px]' : 'bg-[#ff0000]')],
    ['another color each time', (i: number) => `bg-[${hex(i)}]`],
    ['colors and their hover states', (i: number) => `${i % 2 ? 'hover:' : ''}bg-[${hex(i)}]`],
  ] as const) {
    it(`does work in proportion to its length: ${what}`, () => {
      const small = check(400, cls);
      const large = check(1600, cls);
      expect(large.findings).toBe(small.findings * 4);
      // Four times the classes: about four times the work, not sixteen.
      expect(large.distances / small.distances).toBeLessThan(6);
      expect(large.scanned / small.scanned).toBeLessThan(6);
    });
  }

  it('quotes a class of thousands of variants cut short', () => {
    const cls = `${'hover:'.repeat(33_333)}bg-[#ef4444]`;
    const [finding] = ds.check(
      `export const A = () => <div className="${cls}" />\n`,
      'app/a.tsx',
    ).diagnostics;
    expect(finding?.ruleId).toBe('no-hardcoded-color');
    expect(finding?.message.length).toBeLessThan(400);
    const quoted = [...(finding?.message ?? '').matchAll(/`([^`]*)`/g)].map(([, code]) => code);
    // The class and its fix, each cut to 120 characters.
    expect(quoted).toHaveLength(2);
    for (const code of quoted) expect(code).toMatch(/^(?:hover:){19}hover…$/);
    // The fix is whole.
    expect(finding?.fix?.[0]?.text).toBe(`${'hover:'.repeat(33_333)}bg-destructive`);
  });
});
