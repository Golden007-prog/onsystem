// The GitHub Action (action.yml at the repository root): runs `onsystem check`, reports the
// findings on the lines a pull request changed as annotations and in the job summary, and fails
// the step on them. The baseline is applied by `check` itself, told which lines changed so that
// it accepts findings on the other lines first. Plain Node.js with no dependencies, since an
// action runs from a checkout of this repository, not from the package.
// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ ruleId: string, severity: 'error' | 'warning', message: string, line: number,
 *   column: number, endLine: number, endColumn: number }} Diagnostic
 * @typedef {{ file: string, diagnostics: Diagnostic[] }} CheckResult
 * @typedef {Diagnostic & { file: string }} Finding
 * @typedef {Map<string, [number, number][]>} ChangedLines file (relative to the repository root) → line ranges
 * @typedef {{ env: Record<string, string | undefined>, cwd: string,
 *   stdout: (text: string) => void, stderr: (text: string) => void }} Io
 */

const FAIL_ON = ['error', 'warning', 'none'];

/**
 * The lines `git diff --unified=0` shows as added or changed, per file on the new side. A hunk
 * that only deletes marks the lines either side of the gap. That catches a removed `aria-label`
 * only when it was on the line of the tag name, where the finding is, or the line after it: one
 * further down a multi-line tag is missed (docs/required-check.md, test/required-check.test.ts).
 *
 * @param {string} diff
 * @returns {ChangedLines}
 */
export function parseDiff(diff) {
  /** @type {ChangedLines} */
  const changed = new Map();
  /** @type {[number, number][] | undefined} */
  let ranges;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = unquote(line.slice(4).trimEnd());
      ranges = undefined;
      if (name === '/dev/null' || !name.startsWith('b/')) continue;
      ranges = [];
      changed.set(name.slice(2), ranges);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !ranges) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    ranges.push(count === 0 ? [Math.max(1, start), start + 1] : [start, start + count - 1]);
  }
  return changed;
}

/**
 * A path as git prints it: C-quoted (`"b/caf\303\251.tsx"`) when it has unusual characters.
 *
 * @param {string} name
 */
function unquote(name) {
  if (!name.startsWith('"') || !name.endsWith('"')) return name;
  /** @type {Record<string, number>} */
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  /** @type {number[]} */
  const bytes = [];
  const body = name.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const char = body.charAt(i);
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = body.charAt(++i);
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Splits findings into those on changed lines and the rest. With no changed lines given (not a
 * pull request, or every line asked for), every finding is reported.
 *
 * @param {Finding[]} findings
 * @param {ChangedLines | undefined} changed
 */
export function onChangedLines(findings, changed) {
  /** @type {Finding[]} */
  const reported = [];
  /** @type {Finding[]} */
  const outside = [];
  if (!changed) return { reported: findings, outside };
  for (const finding of findings) {
    const ranges = changed.get(finding.file) ?? [];
    const touched = ranges.some(([start, end]) => start <= finding.endLine && end >= finding.line);
    (touched ? reported : outside).push(finding);
  }
  return { reported, outside };
}

/**
 * A workflow command that GitHub shows as an annotation on the file and lines.
 *
 * @param {Finding} finding
 */
export function annotation(finding) {
  const props = [
    `file=${property(finding.file)}`,
    `line=${finding.line}`,
    `col=${finding.column}`,
    `endLine=${finding.endLine}`,
    `endColumn=${finding.endColumn}`,
    `title=${property(`onsystem: ${finding.ruleId}`)}`,
  ];
  return `::${finding.severity === 'error' ? 'error' : 'warning'} ${props.join(',')}::${data(finding.message)}`;
}

/** @param {string} value */
function data(value) {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** @param {string} value */
function property(value) {
  return data(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * `1 error`, `2 warnings`.
 *
 * @param {number} n
 * @param {string} word
 */
function count(n, word) {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim() || (result.error?.message ?? ''),
  };
}

/**
 * The commit a pull request's (or merge group's) changes are measured from, or undefined for
 * any other event.
 *
 * @param {Io['env']} env
 * @returns {string | undefined}
 */
function baseOf(env) {
  const name = env.GITHUB_EVENT_NAME ?? '';
  if (!env.GITHUB_EVENT_PATH) return undefined;
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (name === 'pull_request' || name === 'pull_request_target')
    return event.pull_request?.base?.sha;
  if (name === 'merge_group') return event.merge_group?.base_sha;
  return undefined;
}

/**
 * The lines changed between the base and the files on disk, from where the base and the checked-out
 * commit last met. actions/checkout fetches one commit by default: what the comparison needs is
 * fetched here, a little history at a time.
 *
 * @param {string} base
 * @param {string} cwd
 * @returns {{ top: string, changed: ChangedLines }}
 */
function changedSince(base, cwd) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) throw new Error(`not in a git repository (${top.err})`);
  const head = git(['rev-parse', 'HEAD'], cwd).out;
  /** @param {string[]} args */
  const fetch = (...args) => {
    const fetched = git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', ...args], cwd);
    if (!fetched.ok) throw new Error(`git fetch ${args.join(' ')} failed: ${fetched.err}`);
  };
  if (!git(['cat-file', '-e', `${base}^{commit}`], cwd).ok) fetch('--depth=1', 'origin', base);
  let mergeBase = git(['merge-base', base, head], cwd);
  for (const deepen of [1, 10, 100, 1000]) {
    if (mergeBase.ok) break;
    if (git(['rev-parse', '--is-shallow-repository'], cwd).out !== 'true') break;
    fetch(`--deepen=${deepen}`, 'origin', base, head);
    mergeBase = git(['merge-base', base, head], cwd);
  }
  if (!mergeBase.ok && git(['rev-parse', '--is-shallow-repository'], cwd).out === 'true') {
    fetch('--unshallow', 'origin', base, head);
    mergeBase = git(['merge-base', base, head], cwd);
  }
  if (!mergeBase.ok) throw new Error(`no common history between ${base} and ${head}`);
  // Explicit options, so a user's git config (noprefix, relative, external diff) changes nothing.
  const diff = git(
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-relative',
      '--find-renames',
      '--unified=0',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      mergeBase.out,
      '--',
    ],
    cwd,
  );
  if (!diff.ok) throw new Error(`git diff failed: ${diff.err}`);
  return { top: realPath(top.out), changed: parseDiff(diff.out) };
}

/** @param {string} file */
function realPath(file) {
  try {
    return fs.realpathSync.native(path.resolve(file));
  } catch {
    return path.resolve(file);
  }
}

/**
 * The command that runs the CLI: ONSYSTEM_BIN; else the project's own install, found from
 * `project.cwd` up to `project.top`, the repository root, so the version the lockfile pins runs;
 * else the version this action is released with, through npx.
 *
 * @param {Io['env']} env
 * @param {string} actionPath
 * @param {{ cwd: string, top: string }} [project]
 * @returns {{ command: string, args: string[], shell: boolean, installed?: Installed }}
 */
export function cli(env, actionPath, project) {
  if (env.ONSYSTEM_BIN)
    return { command: process.execPath, args: [env.ONSYSTEM_BIN], shell: false };
  const installed = project && installedCli(project.cwd, project.top);
  if (installed) {
    return { command: process.execPath, args: [installed.script], shell: false, installed };
  }
  // npx is a .cmd script on Windows, which Node only starts through a shell.
  return {
    command: 'npx',
    args: ['--yes', `onsystem@${actionVersion(actionPath)}`],
    shell: process.platform === 'win32',
  };
}

/** @param {string} actionPath */
function actionVersion(actionPath) {
  return String(JSON.parse(fs.readFileSync(path.join(actionPath, 'package.json'), 'utf8')).version);
}

/**
 * @typedef {{ script: string, version: string, dir: string }} Installed
 */

/**
 * The project's own onsystem: `node_modules/onsystem` in `cwd` or the nearest folder above it
 * that has one, up to `top`. Not above it: an install outside the repository is not the
 * project's.
 *
 * @param {string} cwd
 * @param {string} top
 * @returns {Installed | undefined}
 */
export function installedCli(cwd, top) {
  for (let dir = realPath(cwd); ;) {
    const found = installedIn(path.join(dir, 'node_modules', 'onsystem'));
    if (found) return found;
    const parent = path.dirname(dir);
    const rel = path.relative(top, parent);
    if (parent === dir || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    dir = parent;
  }
}

/** @param {string} dir */
function installedIn(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.onsystem;
    if (manifest.name !== 'onsystem' || typeof bin !== 'string') return undefined;
    const script = path.resolve(dir, bin);
    if (!fs.existsSync(script)) return undefined;
    return { script, version: String(manifest.version), dir };
  } catch {
    return undefined;
  }
}

/**
 * The changed lines as `check` reads them from ONSYSTEM_CHANGED_LINES: by the real path of each
 * file, which `changed` names relative to `top`.
 *
 * @param {ChangedLines} changed
 * @param {string} top
 * @returns {Record<string, [number, number][]>}
 */
export function changedLinesByPath(changed, top) {
  /** @type {Record<string, [number, number][]>} */
  const byPath = {};
  for (const [file, ranges] of changed) byPath[realPath(path.join(top, file))] = ranges;
  return byPath;
}

/** @param {string} arg */
function shellQuote(arg) {
  return process.platform === 'win32' ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Runs the action. Inputs come in as INPUT_* variables (see action.yml); resolves to the exit code.
 *
 * @param {Io} io
 */
export function run(io) {
  const { env, cwd } = io;
  /** @type {(name: string, fallback?: string) => string} */
  const input = (name, fallback = '') => (env[`INPUT_${name}`] ?? '').trim() || fallback;
  const paths = input('PATHS', '.').split(/\s+/).filter(Boolean);
  const failOn = input('FAIL_ON', 'error');
  if (!FAIL_ON.includes(failOn)) {
    io.stdout(`::error title=onsystem::fail-on must be error, warning or none, not "${failOn}".`);
    return 1;
  }
  const onlyChanged = input('ONLY_CHANGED_LINES', 'true') !== 'false';
  const args = ['check', ...paths, '--format', 'json'];
  if (input('BASELINE')) args.push('--baseline', input('BASELINE'));
  if (input('REQUIRE_DESIGN_SYSTEM', 'true') !== 'false') args.push('--require-design-system');

  // What changed, before the check: a failed fetch is said plainly rather than after the output.
  const base = onlyChanged ? baseOf(env) : undefined;
  // The repository root, which annotations are relative to: the git top-level, which the diff is
  // relative to too, or the workspace where git is missing or refuses the checkout.
  let top = realPath(git(['rev-parse', '--show-toplevel'], cwd).out || env.GITHUB_WORKSPACE || cwd);
  /** @type {ChangedLines | undefined} */
  let changed;
  if (base) {
    try {
      ({ top, changed } = changedSince(base, cwd));
    } catch (error) {
      io.stdout(
        `::error title=onsystem::Could not work out which lines this pull request changed: ${data(/** @type {Error} */ (error).message)}. Check out with fetch-depth: 0, or set only-changed-lines: false to report every finding.`,
      );
      return 1;
    }
  }

  const actionPath = env.ONSYSTEM_ACTION_PATH ?? path.join(import.meta.dirname, '..');
  const { command, args: prefix, shell, installed } = cli(env, actionPath, { cwd, top });
  const release = installed && actionVersion(actionPath);
  if (installed && installed.version !== release) {
    const where = path.relative(top, installed.dir).split(path.sep).join('/') || installed.dir;
    io.stdout(
      `::notice title=onsystem::Running onsystem ${installed.version}, the project's install in ${data(where)}, rather than ${release}, the version of this action.`,
    );
  }
  // `check` reads the changed lines from a file: a large pull request's would not fit in a
  // variable. An older CLI, such as a project's own install, ignores it.
  let linesDir;
  let linesFile = '';
  if (changed) {
    linesDir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'onsystem-'));
    linesFile = path.join(linesDir, 'changed-lines.json');
    fs.writeFileSync(linesFile, JSON.stringify(changedLinesByPath(changed, top)));
  }
  const all = [...prefix, ...args];
  let checked;
  try {
    checked = spawnSync(command, shell ? all.map(shellQuote) : all, {
      cwd,
      encoding: 'utf8',
      shell,
      maxBuffer: 1024 * 1024 * 1024,
      env: { ...process.env, ...env, ONSYSTEM_CHANGED_LINES: linesFile },
    });
  } finally {
    if (linesDir) fs.rmSync(linesDir, { recursive: true, force: true });
  }
  if (checked.stderr) io.stderr(checked.stderr.trimEnd());
  /** @type {CheckResult[] | undefined} */
  let results;
  if (checked.status === 0 || checked.status === 1) {
    try {
      results = JSON.parse(checked.stdout);
    } catch {
      results = undefined;
    }
  }
  if (!Array.isArray(results)) {
    if (checked.stdout) io.stdout(checked.stdout.trimEnd());
    const why = checked.error?.message ?? checked.stderr?.trim().split('\n')[0] ?? '';
    io.stdout(
      `::error title=onsystem::onsystem check exited with ${checked.status ?? checked.signal}${why ? `: ${data(why)}` : ''}`,
    );
    return 1;
  }

  // Paths relative to the repository root, as the diff and annotations name them.
  /** @type {Finding[]} */
  const findings = results.flatMap((result) => {
    const file = path
      .relative(top, realPath(path.resolve(cwd, result.file)))
      .split(path.sep)
      .join('/');
    return result.diagnostics.map((d) => ({ ...d, file }));
  });
  const { reported, outside } = onChangedLines(findings, changed);
  for (const finding of reported) io.stdout(annotation(finding));

  const errors = reported.filter((f) => f.severity === 'error').length;
  const warnings = reported.length - errors;
  const scope = changed ? ' on lines this pull request changed' : '';
  const rest = outside.length
    ? ` (${count(outside.length, 'finding')} on other lines not reported)`
    : '';
  const headline = `onsystem: ${count(errors, 'error')} and ${count(warnings, 'warning')}${scope} in ${count(results.length, 'file')} checked${rest}.`;
  io.stdout(headline);
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `errors=${errors}\nwarnings=${warnings}\noutside-diff=${outside.length}\n`,
    );
  }
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary(headline, reported));

  if (failOn === 'error' && errors > 0) return 1;
  if (failOn === 'warning' && reported.length > 0) return 1;
  return 0;
}

/**
 * The job summary: the headline, and a table of what was reported (annotations are capped per step).
 *
 * @param {string} headline
 * @param {Finding[]} reported
 */
function summary(headline, reported) {
  // Messages name components as `<Badge>`, which Markdown would take for HTML.
  /** @param {string} text */
  const cell = (text) =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ');
  const rows = reported
    .slice(0, 200)
    .map(
      (f) =>
        `| ${f.severity} | ${codeCell(`${f.file}:${f.line}`)} | \`${f.ruleId}\` | ${cell(f.message)} |`,
    );
  const table = rows.length
    ? ['', '| | Where | Rule | Finding |', '| --- | --- | --- | --- |', ...rows]
    : [];
  const more =
    reported.length > rows.length ? ['', `…and ${reported.length - rows.length} more.`] : [];
  return `${['### onsystem', '', headline, ...table, ...more].join('\n')}\n`;
}

/**
 * A table cell of code: a file name from the pull request, which can hold backticks, Markdown and
 * HTML. The span is fenced with more backticks than the text has in a row, so none ends it, and
 * within it nothing else is read but the table's escapes: `\|` for a `|`, and `\\` for a
 * backslash, so a name's own backslash cannot take a `|` out of the cell (it shows doubled).
 *
 * @param {string} text
 */
function codeCell(text) {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const pad = runs.length ? ' ' : '';
  const escaped = text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return `${fence}${pad}${escaped}${pad}${fence}`;
}
