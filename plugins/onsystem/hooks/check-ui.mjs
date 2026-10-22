#!/usr/bin/env node
// Claude Code PostToolUse hook: after Claude writes or edits a .tsx/.jsx file,
// run `onsystem check` on it and hand the findings back.
//
// Codex runs it too, from the same plugin: its `apply_patch` matches `Write|Edit`,
// and carries the patch in `tool_input.command`. Every .tsx/.jsx file the patch
// adds or updates is checked, in one run per project, a moved file where it moved
// to. Other clients' tools that name the file `path` or `filePath` are read too,
// when their input carries the text they wrote.
//
// - Errors: exit 2 with the findings on stderr, which Claude Code shows to
//   Claude so it fixes them before moving on. For an Edit, or a patch's hunks,
//   only findings on the lines it changed are listed; older ones are counted,
//   not pushed. When the hook cannot tell which lines an Edit changed, the
//   findings it may have caused go back as a non-blocking note instead.
// - Warnings only: exit 0 with `additionalContext`, a non-blocking note.
// - Clean file, other files, a file `check .` leaves out (what the config's
//   `exclude` covers, tests and stories by default: `check --skip-excluded`), or a
//   project without design-system components (tokens alone are not one) and
//   without a config: exit 0 silently. A project in a monorepo whose root has a
//   config takes that config on, so it is checked (by the accessibility rule, for
//   one), as `check .` at the root checks it.
// - The CLI cannot run (npx fails, a min-release-age policy, offline, a private
//   registry, a broken config): exit 0 with a one-time notice, once per session
//   and project, on stderr and as a `systemMessage` the user sees. It never
//   blocks the edit, and Claude is not asked to fix it. When npm could not
//   reach the registry, or npx did not finish in time, npx is not started again
//   for ten minutes, so an offline session waits for npm once, not on every edit.
//
// The CLI is the project's own install when there is one, else npx, pinned to
// this plugin's release. Both run through Node directly, never a shell, so paths
// are passed as they are. npx runs with --prefer-offline: the package in npm's
// cache is used without asking the registry, which npm otherwise does on every
// run, and waits for when offline. The version is exact and a published npm
// version never changes, so the cached copy is the release. When npm itself fails
// with the cache, as when its cached list of versions is older than this release,
// it runs once more with --prefer-online, which asks the registry. A failure of
// the CLI it started, such as a broken config, is not retried.
// It reads the project's files and writes nothing but markers in the system temp
// folder, for the one-time notice and the pause; the only network access is npm's,
// when npx needs the registry.
// The check runs from the file's project folder, the nearest one with a config, a
// components.json, a package.json or a project.json. In a monorepo whose root has a config or
// a baseline (`init` at the root writes both), it runs from the root, as `check .` there does,
// so the root's rules and baseline apply; the file is still checked by its own project. It
// stays in the project folder when the project keeps a baseline of its own, as a CI job per
// app does, and when the root is one project with a design system of its own (its config sets
// `components`, or it has a components.json or components/ui), which `check` there would hold
// every file to.
// ONSYSTEM_BIN points at another CLI script, ONSYSTEM_NPX at another npx script,
// and ONSYSTEM_HOOK_TIMEOUT (milliseconds) shortens the time limit, for tests.
// DESIGN_SYSTEM_MCP_BIN, ONSYSTEM_BIN's name before the rename, still works, with
// a one-time notice.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const PACKAGE = 'onsystem';
// The exact release this plugin runs; scripts/sync-versions.mjs sets it with each release.
const VERSION = '0.9.1';
const UI_FILE = /\.[jt]sx$/i;
const MAX_FINDINGS = 30;
// Both runs together, within the 60 seconds hooks.json gives the hook. Tests shorten it.
const LIMIT = Number(process.env.ONSYSTEM_HOOK_TIMEOUT);
const TIMEOUT = LIMIT > 0 && LIMIT < 55_000 ? LIMIT : 55_000;
// How long npx is not started again after npm could not reach the registry, or ran out of time.
const OFFLINE_PAUSE = 10 * 60_000;
// Where the CLI looks for the design system: the nearest of these marks the project. `check`
// from a monorepo root finds each file's project the same way (src/workspace.ts).
const PROJECT_FILES = [
  'onsystem.config.json',
  'onsystem.config.ts',
  'onsystem.config.mts',
  'onsystem.config.js',
  'onsystem.config.mjs',
  // The names from before the rename, which the CLI still reads.
  'design-system-mcp.config.json',
  'design-system-mcp.config.ts',
  'design-system-mcp.config.mts',
  'design-system-mcp.config.js',
  'design-system-mcp.config.mjs',
  'components.json',
  'package.json',
  // An Nx project without a package.json of its own.
  'project.json',
];
// The config files `check` reads in the folder it runs from, in the order it looks for them.
const CONFIG_FILES = PROJECT_FILES.filter((f) => f.includes('.config.'));
// The baseline `check` reads in the folder it runs from, under its name from before the rename too.
const BASELINE_FILES = ['onsystem.baseline.json', 'design-system-mcp.baseline.json'];
// Where zero config looks for a project's own components (DEFAULT_COMPONENTS in src/config.ts).
const DEFAULT_COMPONENT_DIRS = ['components/ui', 'src/components/ui'];
// The primitives libraries a flat src/ of components wraps (PRIMITIVES in src/detect.ts).
const PRIMITIVES =
  /^(?:react-aria-components|react-aria|radix-ui|@radix-ui\/react-[\w-]+|@base-ui-components\/react|@base-ui\/react|@headlessui\/react|@ark-ui\/react)(?:\/|$)/;
const BIN = process.env.ONSYSTEM_BIN || process.env.DESIGN_SYSTEM_MCP_BIN || undefined;

const input = await readInput();
const sessionDir =
  typeof input?.cwd === 'string' && input.cwd
    ? input.cwd
    : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
// The .tsx and .jsx files the tool wrote, each with the edits it made there.
const targets = editedFiles(input).filter((t) => UI_FILE.test(t.path));
if (!targets.length) process.exit(0);

// One run of `check` per folder it runs from and CLI, with the files it checks there.
const jobs = new Map();
for (const target of targets) {
  const file = path.resolve(sessionDir, target.path);
  const project = projectRoot(path.dirname(file));
  // Where `check` runs: the project's folder, or the monorepo root whose config or baseline covers it.
  const root = (project && monorepoRoot(project)) ?? project ?? sessionDir;
  // The project's own install, which may be in the project's node_modules rather than the root's.
  const cli = resolveCli(project ?? root);
  const key = `${root}\0${cli.argv?.join('\0')}`;
  const job = jobs.get(key) ?? { root, cli, files: [] };
  jobs.set(key, job);
  // Forward slashes, as the CLI prints paths, on Windows too.
  const name = path.relative(root, file).split(path.sep).join('/') || file;
  if (!job.files.some((f) => f.file === file)) job.files.push({ ...target, file, name });
}
if (!process.env.ONSYSTEM_BIN && process.env.DESIGN_SYSTEM_MCP_BIN) {
  // On stderr, the debug log, and only when the hook passes: a blocked edit's stderr is Claude's.
  const text = 'DESIGN_SYSTEM_MCP_BIN is the name ONSYSTEM_BIN had before the rename: rename it.';
  const [{ root }] = jobs.values();
  process.on('exit', (code) => {
    if (code === 0) once('env-notice', root, text, () => fs.writeSync(2, `${text}\n`));
  });
}

const deadline = Date.now() + TIMEOUT;
// What each run found: errors that block, notes that don't, and notices for the user.
const blocks = [];
const notes = [];
const notices = [];
for (const job of jobs.values()) checkFiles(job);

if (blocks.length) {
  // Notes on the other files go with the errors: after exit 2, only stderr reaches the agent.
  process.stderr.write(`${[...blocks, ...notes].join('\n\n')}\n`);
  process.exit(2);
}
const output = {};
for (const { root, text } of notices) {
  once('hook-notice', root, text, () => {
    process.stderr.write(`${text}\n`);
    output.systemMessage = output.systemMessage ? `${output.systemMessage}\n${text}` : text;
  });
}
if (notes.length) {
  output.hookSpecificOutput = {
    hookEventName: 'PostToolUse',
    additionalContext: notes.join('\n\n'),
  };
}
if (Object.keys(output).length) process.stdout.write(JSON.stringify(output));
process.exit(0);

/** Runs `check` on a job's files, and adds what it found to `blocks`, `notes` and `notices`. */
function checkFiles(job) {
  const { root, cli, files } = job;
  if (!cli.argv) return cannotRun(job, 'npx was not found next to this Node.js.');
  // npm could not reach the registry, or npx ran out of time, less than OFFLINE_PAUSE ago: the
  // notice has been shown, and npx would wait as long again.
  const pause = markerPath('offline', root);
  if (cli.npx && paused(pause)) return;

  let run = check(job, cli.npx ? ['--prefer-offline'] : []);
  let results = resultsOf(run);
  // A run from the cache can fail where the registry would not: npm's cached list of versions can
  // predate this release, after the plugin moves to it. When npm itself failed, then, once more with
  // the registry, unless npm could not reach it, which a second run would not change. When the CLI
  // ran and failed (a broken config, a crash), npm did its part: the registry would not change that.
  if (results === undefined && cli.npx && npmFailed(run) && !unreachable(run)) {
    run = check(job, ['--prefer-online']);
    results = resultsOf(run);
  }
  // Anything else (a config error, npx unable to fetch the package) is not Claude's to fix: tell
  // the user once, and move on.
  if (results === undefined) {
    // The next edit would wait as long: npx is paused.
    if (cli.npx && (timedOut(run) || unreachable(run))) {
      try {
        fs.mkdirSync(path.dirname(pause), { recursive: true });
        fs.writeFileSync(pause, '');
      } catch {
        // Without the marker the next edit waits for npm again; it still never blocks.
      }
    }
    return cannotRun(job, failure(cli, run));
  }
  if (!Array.isArray(results)) return;
  for (const target of files) {
    // A run of several files names each result's file relative to the folder it ran in.
    const own =
      files.length === 1
        ? results
        : results.filter(
            (r) => typeof r?.file === 'string' && path.resolve(root, r.file) === target.file,
          );
    report(
      target,
      own.flatMap((r) => (Array.isArray(r?.diagnostics) ? r.diagnostics : [])),
    );
  }
}

/** Adds the findings in one file to `blocks` (errors) or `notes` (warnings, or an unplaced edit). */
function report({ file, name, edits, patch }, diagnostics) {
  if (!diagnostics.length) return;
  // An Edit, or a patch's hunks, is held to the lines it changed; a Write wrote the whole file.
  const edited = editedLines(file, edits, patch);
  const inScope = edited?.lines ? diagnostics.filter((d) => edited.lines.has(d.line)) : diagnostics;
  const elsewhere = diagnostics.length - inScope.length;
  if (!inScope.length) return;

  // Errors first, so a long list of warnings never hides one.
  const ordered = [
    ...inScope.filter((d) => d.severity === 'error'),
    ...inScope.filter((d) => d.severity !== 'error'),
  ];
  const errors = ordered.filter((d) => d.severity === 'error').length;
  const shown = ordered.slice(0, MAX_FINDINGS).map(describe);
  if (ordered.length > shown.length) {
    shown.push(
      `…and ${ordered.length - shown.length} more. Run check_ui on the file to see them all.`,
    );
  }
  const note = elsewhere
    ? `\n(${elsewhere} other ${elsewhere === 1 ? 'finding' : 'findings'} elsewhere in the file predate this edit; leave them unless asked.)`
    : '';

  // An Edit the hook cannot place never blocks: its findings, errors included, go back as a note.
  const unplaced = edited?.placed === false;
  if (errors && !unplaced) {
    blocks.push(
      `${name}: this change breaks the project's design system (onsystem check). ` +
        'Fix these errors before moving on; get_component and get_tokens list the valid props, variants and tokens.\n\n' +
        `${shown.join('\n')}${note}`,
    );
    return;
  }
  const lead = unplaced
    ? `onsystem check: findings in ${name} that this edit may not have caused, since the hook could not tell which lines it changed. Fix the ones it introduced and leave the rest unless asked.`
    : `onsystem check: warnings in ${name}. Prefer the suggested scale values and tokens.`;
  notes.push(`${lead}\n${shown.join('\n')}${note}`);
}

/**
 * Adds a notice that the job's files are not being checked, and why, said once per session and
 * project on stderr (the debug log) and as a `systemMessage` the user sees. Never blocks.
 */
function cannotRun({ root, cli, files }, reason) {
  const names = files.map((f) => f.name);
  const advice = /config|tsconfig|Token file/i.test(reason)
    ? 'Fix the config, or run `onsystem inspect` to see the problem.'
    : cli.npx
      ? `Install it in the project to run it without npx: npm install --save-dev ${PACKAGE}`
      : `Run \`onsystem check ${names.join(' ')}\` to see why.`;
  const text = `onsystem could not check ${names.join(', ')}, so edits are not being checked against the design system: ${reason} ${advice}`;
  notices.push({ root, text });
}

/**
 * The files the tool wrote, as `{ path, edits, patch }`: `edits` are the `{ before, after }` texts
 * it replaced, or undefined for a file written whole, and `patch` is Claude Code's diff of them.
 * Claude Code's Write and Edit (old_string, new_string) name the file in `file_path`. A Codex
 * apply_patch names its files in the patch, in `command`. Other clients' tools name it `path` or
 * `filePath`, with the replaced text in `oldString` and `newString`, or `old_str` and `new_str`.
 * Their tools that read a file name it the same way, and VS Code runs hooks after every tool, so
 * a file named so counts only when the input carries the text written: new text, or the content
 * (`content` or `file_text`). A `code` field is not one: VS Code's insert_edit_into_file sends a
 * snippet with `...existing code...` lines in it, and check_ui sends code it has not saved.
 */
function editedFiles(payload) {
  const tool = payload?.tool_input;
  if (!tool || typeof tool !== 'object') return [];
  if (payload.tool_name === 'apply_patch') {
    return typeof tool.command === 'string' ? patchedFiles(tool.command) : [];
  }
  const fields = [
    ['old_string', 'new_string'],
    ['oldString', 'newString'],
    ['old_str', 'new_str'],
  ].find(([, after]) => typeof tool[after] === 'string');
  const writes = fields || ['content', 'file_text'].some((k) => typeof tool[k] === 'string');
  const file = [tool.file_path, ...(writes ? [tool.path, tool.filePath] : [])].find(
    (f) => typeof f === 'string' && f,
  );
  if (!file) return [];
  const edits = fields && [{ before: tool[fields[0]], after: tool[fields[1]] }];
  return [{ path: file, edits, patch: payload.tool_response?.structuredPatch }];
}

/**
 * The files a Codex apply_patch adds or updates, from its `*** Add File:`, `*** Update File:` and
 * `*** Move to:` lines. An added file is written whole. An updated one is held to its hunks, each
 * the text before (its context and `-` lines) and after (its context and `+` lines), and is
 * checked where `*** Move to:` moved it. A deleted file leaves nothing to check.
 */
function patchedFiles(text) {
  const files = new Map();
  let current;
  let hunk;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const marker = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (marker) {
      const kind = marker[1];
      const file = marker[2].trim();
      hunk = undefined;
      if (kind === 'Move to') {
        if (current) {
          files.delete(current.path);
          current.path = file;
          files.set(file, current);
        }
        continue;
      }
      if (kind === 'Delete File') {
        files.delete(file);
        current = undefined;
        continue;
      }
      current = files.get(file) ?? { path: file, edits: [] };
      if (kind === 'Add File') current.edits = undefined;
      files.set(file, current);
      continue;
    }
    // `*** Begin Patch`, `*** End Patch`, `*** End of File` and the like.
    if (line.startsWith('***')) {
      if (/^\*\*\* (Begin|End) Patch/.test(line)) current = undefined;
      continue;
    }
    // An added file's lines, or none of a file's.
    if (!current?.edits) continue;
    if (line.startsWith('@@') || !hunk) {
      hunk = { before: [], after: [] };
      current.edits.push(hunk);
      if (line.startsWith('@@')) continue;
    }
    const [kind, rest] = [line[0], line.slice(1)];
    if (kind === '-' || kind === ' ' || !line) hunk.before.push(rest);
    if (kind === '+' || kind === ' ' || !line) hunk.after.push(rest);
  }
  return [...files.values()].map(({ path: file, edits }) => ({
    path: file,
    edits: edits?.map((h) => ({ before: h.before.join('\n'), after: h.after.join('\n') })),
  }));
}

/** A marker file in the system temp folder, per session and project (per day without a session). */
function markerPath(kind, root) {
  const day = new Date().toISOString().slice(0, 10);
  const key = createHash('sha256')
    .update(`${input.session_id ?? day}\0${root}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(os.tmpdir(), 'onsystem', `${kind}-${key}`);
}

/** Runs `say` once per session and project (per day without a session), through a marker file. */
function once(kind, root, text, say) {
  const marker = markerPath(kind, root);
  if (fs.existsSync(marker)) return;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${text}\n`);
  } catch {
    // Without a marker the notice may repeat; it still never blocks.
  }
  say();
}

/** Whether npx was paused, in this session and project, less than OFFLINE_PAUSE ago. */
function paused(pause) {
  try {
    return Date.now() - fs.statSync(pause).mtimeMs < OFFLINE_PAUSE;
  } catch {
    return false;
  }
}

/** Runs `check` on the job's files, through npx with `npm` flags, in what is left of TIMEOUT. */
function check({ root, cli, files }, npm) {
  const [command, ...args] = cli.npx
    ? [...cli.argv, ...npm, '--yes', `${PACKAGE}@${VERSION}`]
    : cli.argv;
  // Relative to the folder it runs in, which the CLI sees by its real path: an absolute path
  // through a symlink (macOS's /tmp) would fall outside it, and outside every project in it.
  const paths = files.map(({ file }) => {
    const relative = path.relative(root, file);
    return relative && !path.isAbsolute(relative) ? `.${path.sep}${relative}` : file;
  });
  const spawn = (flags) =>
    spawnSync(
      command,
      [...args, 'check', ...paths, '--format', 'json', '--quiet-without-design-system', ...flags],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        maxBuffer: 64 * 1024 * 1024,
        timeout: Math.max(deadline - Date.now(), 1),
        windowsHide: true,
      },
    );
  // --skip-excluded leaves the file alone when the config's `exclude` covers it, as `check .`
  // and the ESLint plugin do. An older CLI, such as a project's own install, does not know the
  // flag: it runs again without it, and checks the file as it always has.
  const result = spawn(['--skip-excluded']);
  if (result.status === 2 && /Unknown option '--skip-excluded'/.test(result.stderr ?? '')) {
    return spawn([]);
  }
  return result;
}

/** The JSON a run printed, when it exited with 0 (clean or warnings) or 1 (errors). */
function resultsOf(result) {
  if (result.error || (result.status !== 0 && result.status !== 1)) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    // npx exits 1 too when it cannot install the package, with npm's error on stderr.
    return undefined;
  }
}

/** Whether the run was stopped at the deadline: spawnSync's timeout, not any other signal. */
function timedOut(result) {
  return result.error?.code === 'ETIMEDOUT';
}

/**
 * npm's own error lines in a run's stderr (`npm error …`, `npm ERR! …` before npm 10), without
 * the CLI's: npx prints them when it cannot resolve or install the package, not when the CLI
 * it started fails.
 */
function npmErrors(result) {
  return String(result.stderr ?? '')
    .split('\n')
    .filter((line) => /^npm (error|ERR!) /.test(line))
    .join('\n');
}

/** Whether npm itself failed: it exited with its own error, without starting the CLI. */
function npmFailed(result) {
  return !result.error && !result.signal && npmErrors(result) !== '';
}

/** Whether npm said it could not reach the registry. */
function unreachable(result) {
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|network/i.test(
    npmErrors(result),
  );
}

/** Why the CLI did not run, in a sentence, without anything that could hold a credential. */
function failure(cli, result) {
  if (result.error?.code === 'ENOENT') return 'npx was not found.';
  if (timedOut(result)) {
    // npm may have been waiting for the registry, or the CLI for itself: it cannot be told apart.
    return cli.npx
      ? `it did not finish within ${TIMEOUT / 1000} seconds; npm may not have reached the registry (offline?).`
      : `it did not finish within ${TIMEOUT / 1000} seconds.`;
  }
  // Stopped from outside, as when the system runs out of memory.
  if (result.signal) return `it was stopped by ${result.signal}.`;
  const npm = npmErrors(result);
  if (/ENOVERSIONS|No versions available/i.test(npm)) {
    return `npm found no version of ${PACKAGE}@${VERSION} it may install (ENOVERSIONS), as with a min-release-age policy.`;
  }
  if (unreachable(result)) return 'npm could not reach the registry (offline?).';
  if (/E401|E403|ENEEDAUTH|E404|404 Not Found/.test(npm)) {
    return 'the npm registry refused the package (a private registry?).';
  }
  const stderr = String(result.stderr ?? '');
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return `it exited with code ${result.status}.`;
  // URLs can carry credentials (`https://user:token@registry`); keep only what is safe to show.
  const safe = line.replace(/\/\/[^/\s@]+@/g, '//').replace(/(_authToken|token)=\S+/gi, '$1=…');
  return `${safe.length > 200 ? `${safe.slice(0, 199)}…` : safe}${/[.!?]$/.test(safe) ? '' : '.'}`;
}

function describe(d) {
  return `${d.line}:${d.column} ${d.severity} [${d.ruleId}] ${d.message}`;
}

/** The nearest folder at or above `dir` with a design-system config, components.json, package.json or project.json. */
function projectRoot(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (PROJECT_FILES.some((f) => fs.existsSync(path.join(current, f)))) return current;
    if (current === path.dirname(current)) return undefined;
  }
}

/**
 * The monorepo root to run `check` from for a file in `dir`, its project folder: the nearest
 * workspace root at or above `dir`, when it has a config or a baseline and `check` reads it as
 * its projects. `check` there finds the file's project as the hook does, then adds the root's
 * config (to a project without its own) and the root's baseline. None when `dir` is the root
 * itself, keeps a baseline of its own, the root has neither file, or the root is one project
 * with a design system of its own. The home folder is never one.
 */
function monorepoRoot(dir) {
  if (BASELINE_FILES.some((f) => fs.existsSync(path.join(dir, f)))) return undefined;
  const home = os.homedir();
  for (let up = dir; up !== path.dirname(up); up = path.dirname(up)) {
    if (up === home || !isWorkspaceRoot(up)) continue;
    if (up === dir) return undefined;
    const config = configFile(up);
    if (!config && !BASELINE_FILES.some((f) => fs.existsSync(path.join(up, f)))) return undefined;
    return isOneProject(up, config) ? undefined : up;
  }
  return undefined;
}

/**
 * The config file `check` reads in `dir`: the first of CONFIG_FILES there, else the JSON file
 * its package.json names in its `onsystem` field, as a design-system package declares one.
 */
function configFile(dir) {
  const named = CONFIG_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (named) return named;
  const declared = readJson(path.join(dir, 'package.json'))?.onsystem;
  if (typeof declared !== 'string' || !declared.endsWith('.json')) return undefined;
  const file = path.resolve(dir, declared);
  return fs.existsSync(file) ? file : undefined;
}

/**
 * Whether `check` at `dir`, a monorepo root, reads it as one project with a design system of
 * its own rather than as its projects (loadTarget in src/workspace.ts): its config sets
 * `components`, or zero config finds components at the root. `check` there would hold every
 * file below the root to the root's design system, another project's own components included,
 * so the hook stays in the file's project. Read cheaply, and leaning to one project: where zero
 * config would look counts, without following it to the component files.
 */
function isOneProject(dir, config) {
  if (config && setsComponents(config)) return true;
  // A components.json, or components in the default folders.
  if (fs.existsSync(path.join(dir, 'components.json'))) return true;
  if (DEFAULT_COMPONENT_DIRS.some((d) => holdsComponent(path.join(dir, d)))) return true;
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) return false;
  // The root's own exports.
  if (pkg.exports !== undefined) return true;
  if (typeof pkg.main === 'string' && /^\.?\/?(?:dist|build|lib)\//.test(pkg.main)) return true;
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  // A workspace package it depends on, named like a design system (@acme/ui).
  const designSystem = Object.entries(dependencies).some(
    ([name, spec]) => isDesignSystemName(name) && isWorkspacePackage(dir, name, spec),
  );
  if (designSystem) return true;
  // A flat src/ of PascalCase components on a primitives library, as React Aria's starter has.
  return (
    Object.keys({ ...dependencies, ...pkg.peerDependencies }).some((n) => PRIMITIVES.test(n)) &&
    listDir(path.join(dir, 'src')).some(
      (e) => e.isFile() && /^[A-Z][A-Za-z0-9]*\.[jt]sx$/.test(e.name),
    )
  );
}

/**
 * Whether the config file `file` sets `components`. A JavaScript or TypeScript config gives its
 * fields only when run, so any mention counts. Broken JSON does not: `check` from the root
 * reports it, once, without blocking the edit.
 */
function setsComponents(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  if (!file.endsWith('.json')) return /\bcomponents\b/.test(text);
  try {
    return JSON.parse(text)?.components !== undefined;
  } catch {
    return false;
  }
}

/** Whether `dir` holds a .tsx or .jsx file, at any depth outside node_modules. */
function holdsComponent(dir) {
  return listDir(dir).some((e) =>
    e.isDirectory()
      ? e.name !== 'node_modules' && holdsComponent(path.join(dir, e.name))
      : /\.[jt]sx$/.test(e.name),
  );
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** A package name like a design system's (isDesignSystemName in src/detect.ts): @acme/ui, acme-ui. */
function isDesignSystemName(name) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return (
    /^(?:ui|ui-kit|uikit|ui-react|react-ui|design-system|ds|components|primitives)$/.test(base) ||
    /-(?:ui|ui-kit|design-system)$/.test(base)
  );
}

/**
 * Whether the dependency `name` of `dir` is a workspace package: `workspace:` in its version, or
 * linked into node_modules from outside one. Zero config reads only those, not installed packages.
 */
function isWorkspacePackage(dir, name, spec) {
  if (typeof spec === 'string' && spec.startsWith('workspace:')) return true;
  try {
    const linked = fs.realpathSync(path.join(dir, 'node_modules', name));
    return !path.relative(fs.realpathSync(dir), linked).split(path.sep).includes('node_modules');
  } catch {
    return false;
  }
}

/**
 * A monorepo root, as `check` reads one (isWorkspaceRoot in src/detect.ts): a pnpm-workspace.yaml
 * whose `packages` name more than the root, `workspaces` in package.json, an nx.json, or a
 * lerna.json with `packages`. A pnpm-workspace.yaml with settings alone is a single app's.
 */
function isWorkspaceRoot(dir) {
  const beyondRoot = (p) =>
    !p.startsWith('!') && path.posix.normalize(p.replace(/\\/g, '/').replace(/\/+$/, '')) !== '.';
  if (pnpmPackages(dir).some(beyondRoot)) return true;
  if (fs.existsSync(path.join(dir, 'nx.json'))) return true;
  if (readJson(path.join(dir, 'package.json'))?.workspaces !== undefined) return true;
  return Array.isArray(readJson(path.join(dir, 'lerna.json'))?.packages);
}

/** The `packages` list of the pnpm-workspace.yaml in `dir`, block or flow style, as `check` reads it. */
function pnpmPackages(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return [];
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^(['"]?)packages\1\s*:/.test(line));
  if (start === -1) return [];
  const uncomment = (s) => s.replace(/(?:^|\s)#.*$/, '').trim();
  const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const inline = uncomment(lines[start].slice(lines[start].indexOf(':') + 1));
  if (inline.startsWith('[')) {
    let flow = inline;
    for (let i = start + 1; !flow.includes(']') && i < lines.length; i++) {
      flow += ` ${uncomment(lines[i])}`;
    }
    const end = flow.indexOf(']');
    return flow
      .slice(1, end === -1 ? undefined : end)
      .split(',')
      .map(unquote)
      .filter(Boolean);
  }
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) items.push(unquote(uncomment(item[1])));
    // The next top-level key ends the list.
    else if (/^\S/.test(line)) break;
  }
  return items.filter(Boolean);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * How to start the CLI: `argv` ([node, script] or ['npx']) runs an override, the project's
 * install, or npx (`npx: true`, without npm's flags and the package). No `argv`: no npx found.
 */
function resolveCli(dir) {
  if (BIN) return { argv: [process.execPath, BIN] };
  const installed = installedCli(dir);
  if (installed) return { argv: [process.execPath, installed] };
  // npm's own npx script, run with this Node: no shell, so no quoting or .cmd issues on Windows.
  const nodeDir = path.dirname(process.execPath);
  const npx =
    process.env.ONSYSTEM_NPX ||
    [
      path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    ].find((f) => fs.existsSync(f));
  if (npx) return { argv: [process.execPath, npx], npx: true };
  return { argv: process.platform === 'win32' ? undefined : ['npx'], npx: true };
}

/** The CLI script of the project's own install, if it has one. */
function installedCli(dir) {
  try {
    const manifest = createRequire(path.join(dir, 'package.json')).resolve(
      `${PACKAGE}/package.json`,
    );
    const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const script = typeof bin === 'string' ? bin : bin?.[PACKAGE];
    return script ? path.resolve(path.dirname(manifest), script) : undefined;
  } catch {
    // Not installed in the project: npx runs it.
    return undefined;
  }
}

/**
 * The 1-based lines `edits` changed in `file`, or undefined for the whole file (a Write, or a
 * file a patch adds). Each edit is the text it replaced and its new text: an Edit's old_string
 * and new_string, or a patch hunk. Lines an edit repeats unchanged from the old text are not its
 * own, and an edit that only removes lines, which changes none, is not looked for. `placed` is
 * false when the hook cannot tell where an edit is: its new text is in the file more than once, or
 * no longer as written (a formatter rewrote it); `lines` are then the lines it may be on, or
 * undefined for any.
 */
function editedLines(file, edits, structuredPatch) {
  if (!edits) return undefined;
  // Removing text adds no finding of its own.
  const adding = edits.filter((edit) => edit.after.trim());
  if (!adding.length) return { lines: new Set(), placed: true };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return { lines: undefined, placed: false };
  }
  // Claude Code's own diff of the edit, while the file still matches it.
  const patched = patchLines(structuredPatch, text.split('\n'));
  if (patched) return { lines: patched, placed: true };
  const lines = new Set();
  let placed = true;
  for (const { before, after } of adding) {
    const replacement = after.replace(/\r\n/g, '\n');
    const changed =
      typeof before === 'string'
        ? changedLines(before.replace(/\r\n/g, '\n').split('\n'), replacement.split('\n'))
        : replacement.split('\n').map((_, i) => i);
    // A patch hunk that only deletes lines keeps its context, which may well be in the file twice.
    if (!changed.length) continue;
    let matches = 0;
    // One pass over the file: lines are counted from the previous match, not from the top.
    for (
      let at = text.indexOf(replacement), line = 1, counted = 0;
      at !== -1;
      at = text.indexOf(replacement, at + 1)
    ) {
      for (; counted < at; counted++) if (text.charCodeAt(counted) === 10) line++;
      matches++;
      for (const offset of changed) lines.add(line + offset);
    }
    if (!matches) return { lines: undefined, placed: false };
    if (matches > 1) placed = false;
  }
  return { lines, placed };
}

/** The new-file lines a structuredPatch adds, if every line it shows is still in the file there. */
function patchLines(hunks, current) {
  if (!Array.isArray(hunks) || !hunks.length) return undefined;
  const added = new Set();
  for (const hunk of hunks) {
    if (!Number.isInteger(hunk?.newStart) || !Array.isArray(hunk.lines)) return undefined;
    let line = hunk.newStart;
    for (const entry of hunk.lines) {
      if (typeof entry !== 'string') return undefined;
      const [kind, text] = [entry[0], entry.slice(1).replace(/\r$/, '')];
      if (kind === '-' || kind === '\\') continue;
      if ((kind !== '+' && kind !== ' ') || current[line - 1] !== text) return undefined;
      if (kind === '+') added.add(line);
      line++;
    }
  }
  return added;
}

/** Indexes of the lines of `after` that a line diff from `before` adds or changes. */
function changedLines(before, after) {
  // Too big to diff: every line counts.
  if (before.length * after.length > 1_000_000) return after.map((_, j) => j);
  // common[i * width + j]: the longest common subsequence of before[i..] and after[j..].
  const width = after.length + 1;
  const common = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i * width + j] =
        before[i] === after[j]
          ? common[(i + 1) * width + j + 1] + 1
          : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const changed = [];
  for (let i = 0, j = 0; j < after.length;) {
    if (i < before.length && before[i] === after[j]) {
      i++;
      j++;
    } else if (i < before.length && common[(i + 1) * width + j] >= common[i * width + j + 1]) {
      i++;
    } else {
      changed.push(j++);
    }
  }
  return changed;
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}
