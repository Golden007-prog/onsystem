import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { run } from '../action/check.mjs';
import { fixture } from './helpers.js';

// The job summary shows each finding's file in a code span. A pull request names the files, and
// a backtick in a name ended the span early: the rest of the name rendered as Markdown, such as
// an image the summary then loaded.

/** A stand-in for the CLI that reports the results it is given. */
const STUB = `const results = JSON.parse(process.env.STUB_RESULTS);
console.log(JSON.stringify(results));
process.exit(1);
`;

/** The job summary of one finding in `file`. */
function summaryFor(file: string): string {
  const dir = fixture({ 'stub.mjs': STUB, [file]: 'export default () => null;\n' });
  const summary = path.join(dir, 'summary.md');
  const diagnostic = {
    ruleId: 'no-hardcoded-color',
    severity: 'error',
    message: 'Hardcoded color `#111111` in <div>.',
    line: 2,
    column: 3,
    endLine: 2,
    endColumn: 10,
    source: '#111111',
  };
  run({
    cwd: dir,
    env: {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_STEP_SUMMARY: summary,
      ONSYSTEM_BIN: path.join(dir, 'stub.mjs'),
      INPUT_ONLY_CHANGED_LINES: 'false',
      STUB_RESULTS: JSON.stringify([
        { file, diagnostics: [diagnostic], errorCount: 1, warningCount: 0 },
      ]),
    },
    stdout: () => undefined,
    stderr: () => undefined,
  });
  return fs.readFileSync(summary, 'utf8');
}

describe("the Action's job summary", () => {
  it('keeps a file name with backticks in its code span', () => {
    const row = summaryFor('app/x`![t](p.png)`.tsx')
      .split('\n')
      .find((line) => line.startsWith('| error |'));
    expect(row).toBe(
      '| error | `` app/x`![t](p.png)`.tsx:2 `` | `no-hardcoded-color` | Hardcoded color `#111111` in &lt;div&gt;. |',
    );
  });

  // Windows allows none of these characters in a file name.
  it.skipIf(process.platform === 'win32')('shows the rest of a file name as it is', () => {
    const row = summaryFor('app/a|b <c> & d.tsx')
      .split('\n')
      .find((line) => line.startsWith('| error |'));
    expect(row).toContain('| `app/a\\|b <c> & d.tsx:2` |');
    // A backslash before the `|` is escaped too, so the `|` stays escaped and in the cell. The
    // trade-off: a name's own backslash shows doubled in the summary. Paths are written with
    // forward slashes, so a Windows path has none.
    expect(summaryFor('app/a\\|b.tsx')).toContain('| `app/a\\\\\\|b.tsx:2` |');
  });

  it('names an ordinary file as before', () => {
    expect(summaryFor('app/page.tsx')).toContain(
      '| error | `app/page.tsx:2` | `no-hardcoded-color` |',
    );
  });
});
