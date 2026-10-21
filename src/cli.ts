import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';

import type { Transport } from '@modelcontextprotocol/server';
import { escapePath, glob, type GlobOptions } from 'tinyglobby';
import ts from 'typescript';

import {
  applyBaseline,
  BASELINE_FILE,
  countBaseline,
  findMoves,
  goneFiles,
  LEGACY_BASELINE_FILE,
  onLines,
  pruneBaseline,
  readBaseline,
  rulesRun,
  unrecordedRules,
  updateBaseline,
  writeBaseline,
  type LineRanges,
} from './baseline.js';
import {
  ConfigError,
  excludedBy,
  RULE_IDS,
  rulesFor,
  type LoadConfigOptions,
  type ResolvedConfig,
  type RuleId,
} from './config.js';
import { componentFiles, loadDesignSystem, type DesignSystem } from './design-system.js';
import { explainProject, librariesLeftOut } from './explain.js';
import { init } from './init.js';
import { libraryTitle, notReadYet, type LibrarySource } from './libraries/index.js';
import { escapeData, formatDiagnostics, uncheckedNotice, type OutputFormat } from './lint/index.js';
import { missingDependencies, notReadNotices } from './not-read.js';
import { serveStdio } from './server/stdio.js';
import { toDesignMd, toDtcg } from './tokens/export.js';
import type { CheckResult, DesignSystemModel, Diagnostic } from './types.js';
import { stderrLogger, silentLogger } from './util/log.js';
import { isInside, relativePath, SCRIPT_FILE, toPosix } from './util/paths.js';
import { plural, unique } from './util/strings.js';
import { NAME, VERSION } from './version.js';
import { loadTarget, type Project, type Workspace } from './workspace.js';
import { detectProject, type DetectionStep } from './detect.js';

const DOCS = 'https://onsystem.vercel.app/docs';

const HELP = `${NAME} ${VERSION}

Keeps coding agents on your React design system: checks UI code against your
real components, props, variants and tokens in a Claude Code hook, in CI with
check, and over MCP for any agent.

Usage
  onsystem [serve] [options]     Start the MCP server on stdio (default)
  onsystem check <paths...>      Lint files, folders or globs with the check_ui rules
                                 (for CI)
  onsystem inspect               Print what was extracted from the project
  onsystem export --format dtcg|design-md
                                 Print the tokens it found as a DTCG 2025.10 file or a
                                 DESIGN.md (--out <file> writes them to a file)
  onsystem init                  Write onsystem.config.json from what was found, run a
                                 dry-run check and offer a baseline
  onsystem help                  Show this help

At a monorepo root with no design system of its own, every command works per
project: each file is checked against the design system of the nearest folder
with a config, components.json or package.json, and inspect lists every project.

Options
  --root <dir>            Project root (default: the config file's directory, or cwd)
  --config <file>         Config file (default: onsystem.config.{json,ts,mjs,js})
  --components <glob>     Component sources, repeatable (default: found through
                          components.json or a workspace package, else
                          components/ui/**/*.{tsx,jsx} and src/components/ui/...)
  --tokens <file>         Token file (DTCG .json or CSS), repeatable
  --docs <glob>           Component docs (Markdown/MDX), repeatable
  --no-cache              Ignore the on-disk extraction cache
  --no-watch              serve: do not reload when files change
  --format <format>       check: pretty | json | github | sarif (default: pretty);
                          export: dtcg | design-md
  --out <file>            export: write to this file instead of stdout
  --max-warnings <n>      check: exit 1 when there are more than n warnings
  --update-baseline       check: record the current findings as accepted, and exit 0
  --prune-baseline        check: drop baseline entries that no longer occur, and
                          accept nothing new
  --baseline <file>       check: baseline file (default: ${BASELINE_FILE} in the root,
                          used whenever it exists)
  --ignore-baseline       check: report every finding, baseline or not
  --include-design-system
                          check: also lint the design system's own component
                          files, which are skipped by default
  --include-tests         check: also lint tests and stories (*.test.tsx,
                          *.spec.tsx, *.stories.tsx) in folders and globs
  --skip-excluded         check: leave out files named outright that the config's
                          exclude covers, as folders and globs leave them out
                          (the Claude Code hook passes it)
  --quiet-without-design-system
                          check: print nothing and exit 0 when the project has no
                          design-system components and no config (tokens alone
                          are not a design system), for hooks installed across
                          many projects
  --require-design-system
                          check: exit 2 when no components or no color tokens
                          are found, or when the folders and globs given leave
                          no file to check, so CI cannot pass by checking nothing
  --explain               inspect: every candidate zero config looked at and why
                          it was taken or not, the resolved config, unresolved
                          tokens, and components whose props did not resolve
  -y, --yes               init: write without asking, and record the baseline
  --force                 init: replace an existing config file
  -h, --help              Show this help
  -v, --version           Show the version

Examples
  npx -y ${NAME} inspect --explain
  npx -y ${NAME} init
  npx -y ${NAME} check . --format github --require-design-system
  npx -y ${NAME} check . --update-baseline   # adopt in an existing codebase

Docs: ${DOCS}
`;

export interface Io {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  /** Asks a question in the terminal (`init`); undefined when there is none to ask in. */
  prompt?: ((question: string) => Promise<string>) | undefined;
  /** Environment variables (GITHUB_WORKSPACE); the process's by default. */
  env?: Record<string, string | undefined> | undefined;
  /** Whether stdin is a terminal rather than an MCP client's pipe. */
  stdinIsTTY?: boolean | undefined;
  /** The transport `serve` uses instead of stdio, for tests. */
  transport?: Transport | undefined;
}

const defaultIo: Io = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  color: process.stdout.isTTY && !process.env.NO_COLOR,
  prompt: process.stdin.isTTY && process.stdout.isTTY ? askInTerminal : undefined,
  stdinIsTTY: process.stdin.isTTY,
};

/** One question on the terminal, answered with a line. */
async function askInTerminal(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Runs the CLI. Resolves to an exit code; `serve` resolves once the server is listening. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        root: { type: 'string' },
        config: { type: 'string' },
        components: { type: 'string', multiple: true },
        tokens: { type: 'string', multiple: true },
        docs: { type: 'string', multiple: true },
        cache: { type: 'boolean', default: true },
        watch: { type: 'boolean', default: true },
        format: { type: 'string' },
        out: { type: 'string' },
        'max-warnings': { type: 'string' },
        baseline: { type: 'string' },
        'update-baseline': { type: 'boolean', default: false },
        'prune-baseline': { type: 'boolean', default: false },
        'ignore-baseline': { type: 'boolean', default: false },
        'quiet-without-design-system': { type: 'boolean', default: false },
        'include-design-system': { type: 'boolean' },
        'include-tests': { type: 'boolean', default: false },
        'skip-excluded': { type: 'boolean', default: false },
        'require-design-system': { type: 'boolean', default: false },
        explain: { type: 'boolean', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\nRun ${NAME} --help for usage.`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(HELP);
    return 0;
  }
  if (values.version) {
    io.stdout(VERSION);
    return 0;
  }

  const [command = 'serve', ...rest] = positionals;
  if (command === 'help') {
    io.stdout(HELP);
    return 0;
  }
  // `--root ${workspaceFolder}` from a client that does not expand variables
  // would make a folder of that name the project.
  let root = values.root;
  if (root !== undefined && /\$\{[^}]*\}/.test(root)) {
    io.stderr(
      `--root "${root}" holds a variable the client did not expand; using the working directory instead${command === 'serve' ? ", or the client's roots when it holds no project" : ''}.`,
    );
    root = undefined;
  }
  const configOptions = {
    cwd: io.cwd,
    root,
    config: values.config,
    components: values.components,
    tokens: values.tokens,
    docs: values.docs,
    includeDesignSystem: values['include-design-system'],
  };

  try {
    switch (command) {
      case 'serve':
        // `npx onsystem` typed in a terminal waits on stdin for an agent that never comes: say so.
        // An MCP client's stdin is a pipe, and stdout belongs to the protocol.
        if (io.stdinIsTTY) {
          io.stderr(
            `${NAME} is an MCP server: it is waiting for an agent on stdin. Add it to your agent (${DOCS}/clients), or run \`npx -y ${NAME} inspect\` or \`npx -y ${NAME} check .\` here. Ctrl+C quits.`,
          );
        }
        await serveStdio({
          ...configOptions,
          cache: values.cache,
          watch: values.watch,
          logger: stderrLogger,
          ...(io.transport ? { transport: io.transport } : {}),
        });
        return 0;
      case 'check':
        return await check(rest, configOptions, values, io);
      case 'inspect':
        return await inspect(configOptions, values, io);
      case 'export':
        return await exportTokens(configOptions, values, io);
      case 'init':
        return await init(
          configOptions,
          { yes: values.yes, force: values.force, cache: values.cache },
          io,
          async (args, checkIo) => {
            const out: string[] = [];
            const err: string[] = [];
            const code = await main(args, {
              cwd: checkIo.cwd,
              color: false,
              stdout: (t) => out.push(t),
              stderr: (t) => err.push(t),
            });
            return { code, stdout: out.join('\n'), stderr: err.join('\n') };
          },
        );
      default:
        io.stderr(`Unknown command "${command}". Run ${NAME} --help for usage.`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(error.message);
      return 2;
    }
    // Exit 1 means findings. A run that failed (a file it cannot read, a bug) exits 2, as a
    // broken config does, so CI fails the job rather than taking an empty report for findings.
    io.stderr((error as Error).stack ?? String(error));
    return 2;
  }
}

interface CheckValues {
  cache: boolean;
  format?: string | undefined;
  'max-warnings'?: string | undefined;
  baseline?: string | undefined;
  'update-baseline': boolean;
  'prune-baseline': boolean;
  'ignore-baseline': boolean;
  'quiet-without-design-system': boolean;
  'require-design-system': boolean;
  'include-tests': boolean;
  'skip-excluded': boolean;
}

/** The files a run checks, and what to say about the rest. */
interface Selection {
  files: string[];
  /** The design system each file is checked against. */
  designSystemOf: (file: string) => DesignSystem;
  /** The folder baseline keys are relative to, where the default baseline lives. */
  root: string;
  notes: string[];
  /** Rules that could not run, said once after the findings. */
  notices: string[];
  /** Design-system files left out, for the hint when nothing is left. */
  skipped: number;
  testsLeftOut: number;
  /** `.js` files under the folders given that have JSX, which folders leave out. */
  jsx: string[];
  /** The globs that name those `.js` files, for the command that checks them. */
  jsxGlobs: string[];
  /** Whether a folder or glob was given, rather than only files named outright. */
  searched: boolean;
}

/**
 * No file matched the patterns. The `.js` files with JSX the folders hold, which folders leave
 * out, say why when there are any: `check app` in a JavaScript app.
 */
interface NoMatch {
  noMatch: true;
  jsx: string[];
  jsxGlobs: string[];
}

async function check(
  patterns: string[],
  configOptions: LoadConfigOptions,
  values: CheckValues,
  io: Io,
): Promise<number> {
  if (values['quiet-without-design-system'] && values['require-design-system']) {
    io.stderr('check: pass --quiet-without-design-system or --require-design-system, not both');
    return 2;
  }
  for (const other of ['update-baseline', 'ignore-baseline'] as const) {
    if (values['prune-baseline'] && values[other]) {
      io.stderr(`check: pass --prune-baseline or --${other}, not both`);
      return 2;
    }
  }
  if (!patterns.length) {
    io.stderr(`check: pass files, folders or globs, e.g. ${NAME} check .`);
    return 2;
  }
  const format = (values.format ?? 'pretty') as OutputFormat;
  if (!['pretty', 'json', 'github', 'sarif'].includes(format)) {
    io.stderr(`check: unknown --format "${format}" (pretty, json, github, sarif)`);
    return 2;
  }
  const maxWarnings =
    values['max-warnings'] === undefined ? undefined : Number(values['max-warnings']);
  if (maxWarnings !== undefined && !Number.isInteger(maxWarnings)) {
    io.stderr('check: --max-warnings expects an integer');
    return 2;
  }

  const target = await loadTarget(configOptions);
  warnDeprecated(target.config.deprecations, format, io);
  warnDeprecated(configWarnings(target), format, io);
  const selection = target.workspace
    ? await selectInWorkspace(target.workspace, patterns, values, format, io)
    : await selectInProject(target.config, patterns, values, format, io);
  if (typeof selection === 'number') return selection;
  // The hints repeat the options that decide the findings and the baseline, so the command they
  // suggest rewrites the same file from the same findings.
  const command = (flag: string) => checkCommand(patterns, configOptions, values, flag);
  if ('noMatch' in selection) {
    const jsx = jsxNotice(selection, io.cwd, command);
    io.stderr(
      jsx
        ? `check: nothing to check in ${patterns.join(' ')}. ${jsx}`
        : `check: no files match ${patterns.join(' ')}`,
    );
    return 2;
  }
  const { files, notes } = selection;
  // What the run could not do or left out, after the findings: on stdout, as a workflow warning
  // with `--format github`, and on stderr when stdout is JSON or SARIF.
  const notify = (text: string) => {
    if (format === 'pretty') io.stdout(text);
    else if (format === 'github') io.stdout(`::warning title=${NAME}::${text}`);
    else io.stderr(text);
  };
  const jsx = jsxNotice(selection, io.cwd, command);
  if (!files.length) {
    // `.js` files with JSX are what is left to check: --include-design-system or
    // --include-tests would check something else and pass with the pages still unchecked.
    const hints = jsx
      ? [jsx]
      : [
          selection.skipped
            ? `Pass --include-design-system to check ${selection.skipped === 1 ? 'it' : 'them'}.`
            : '',
          selection.testsLeftOut ? 'Pass --include-tests to check tests and stories.' : '',
        ].filter(Boolean);
    // Folders and globs that leave nothing to check point at the wrong code, or at code `check`
    // does not read: CI must not pass on them. Files named outright that are not JS or TS (a
    // pull request that changes only styles) have nothing to check. One line, as the GitHub
    // Action's error annotation shows only the first.
    if (values['require-design-system'] && selection.searched) {
      io.stderr(
        `check --require-design-system: nothing was checked${notes.length ? ` (${notes.join('; ')})` : ''}. ${hints.join(' ')}`.trimEnd(),
      );
      return 2;
    }
    if (format === 'pretty') {
      io.stdout(
        `Nothing to check${notes.length ? `: ${notes.join('; ')}` : ''}. ${hints.join(' ')}`.trimEnd(),
      );
    } else {
      printNoResults(format, io);
      if (jsx) notify(jsx);
    }
    return 0;
  }

  const update = values['update-baseline'];
  const prune = values['prune-baseline'];
  const baselineFile = values.baseline
    ? path.resolve(io.cwd, values.baseline)
    : defaultBaseline(
        selection.root,
        values['ignore-baseline']
          ? undefined
          : (text) => {
              warnDeprecated([text], format, io);
            },
      );
  // Read before an update too: a baseline mangled by a merge conflict must not be overwritten silently.
  const baseline = values['ignore-baseline'] ? undefined : readBaseline(baselineFile);
  if (values.baseline && !update && !values['ignore-baseline'] && !baseline) {
    io.stderr(`check: baseline not found: ${displayPath(io.cwd, baselineFile)}`);
    return 2;
  }
  if (prune && !baseline) {
    io.stderr(
      `check --prune-baseline: no baseline to prune at ${displayPath(io.cwd, baselineFile)}. Pass --baseline <file> to prune another one, or record the current findings with \`${checkCommand(patterns, configOptions, values, '--update-baseline')}\`.`,
    );
    return 2;
  }
  // Entries of rules that are off for a file (in `rules` or an override) are kept, not reported as fixed.
  const disabledFor = (file: string) => {
    const ds = selection.designSystemOf(file);
    return new Set(
      Object.entries(rulesFor(ds.config, relativePath(ds.root, file)))
        .filter(([, rule]) => rule.severity === 'off')
        .map(([id]) => id),
    );
  };
  const disabledByKey = new Map<string, Set<string>>();
  // Keys are relative to the real root, with the on-disk spelling of each path and
  // NFC names, so `APP/`, a linked root or a decomposed `café.tsx` find the same entry.
  const realRoot = fs.realpathSync.native(selection.root);
  // The folders given, which a run covers whole: those that name the root or a folder above it
  // check every file under the root that a later run with the same options checks.
  const folders = patterns
    .map((pattern) => path.resolve(io.cwd, pattern))
    .filter((dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    .map(realPath);
  // The lines a pull request changed, from the GitHub Action: the baseline accepts findings on
  // the other lines first.
  const changedLines =
    baseline && !update ? readChangedLines(io.env ?? process.env, io.cwd) : undefined;

  const results: CheckResult[] = [];
  const checked = new Map<string, Diagnostic[]>();
  // The rules that ran, which the baseline records, so a later run can say why a rule's findings are new to it.
  const ran = new Set<RuleId>();
  let baselined = 0;
  let fixed = 0;
  // Files without entries of their own, which may have moved: matched once every file is checked.
  const unrecorded: {
    index: number;
    key: string;
    result: CheckResult;
    disabled: ReadonlySet<string>;
    changed: LineRanges | undefined;
  }[] = [];
  for (const file of files) {
    const code = await fsp.readFile(file, 'utf8');
    const ds = selection.designSystemOf(file);
    let result = ds.check(code, relativePath(ds.root, file));
    const real = fs.realpathSync.native(file);
    const key = relativePath(realRoot, real).normalize('NFC');
    const disabled = disabledFor(file);
    disabledByKey.set(key, disabled);
    if (update || prune) checked.set(key, result.diagnostics);
    if (update) {
      for (const rule of RULE_IDS) if (!disabled.has(rule) && canRun(ds, rule)) ran.add(rule);
    }
    if (baseline && !update) {
      const changed = changedLines?.get(real);
      if (baseline.entries.has(key)) {
        const match = applyBaseline(baseline.entries, key, result, disabled, changed);
        result = { ...match.result, baselined: match.baselined };
        baselined += match.baselined;
        fixed += match.fixed;
      } else {
        unrecorded.push({ index: results.length, key, result, disabled, changed });
      }
    }
    results.push({ ...result, file: relativePath(io.cwd, file) });
  }
  // A file renamed or moved has the findings of an entry whose file no longer exists: the
  // entry accepts them where the file is now. What is left of such entries in the folders the
  // run covers no longer occurs.
  let moves = new Map<string, string>();
  if (baseline && !update) {
    const covered = (key: string) => folders.some((dir) => isInside(dir, path.join(realRoot, key)));
    const matching = unrecorded.some((u) => u.result.diagnostics.length);
    const gone = goneFiles(
      baseline.entries,
      realRoot,
      new Set(disabledByKey.keys()),
      (key) => matching || covered(key),
    );
    // With the lines a pull request changed, a file it did not touch keeps the entries it took
    // over in an earlier move, rather than a copy the pull request adds taking them.
    const changedIn = new Map(unrecorded.map((u) => [u.key, u.changed]));
    moves = findMoves(
      baseline.entries,
      new Map(unrecorded.map((u) => [u.key, u.result.diagnostics])),
      gone,
      (key) => disabledByKey.get(key) ?? new Set(),
      (key, diagnostic) => onLines(changedIn.get(key), diagnostic),
    );
    for (const { index, key, result, disabled, changed } of unrecorded) {
      const from = moves.get(key) ?? key;
      const match = applyBaseline(baseline.entries, from, result, disabled, changed);
      const file = results[index]?.file ?? result.file;
      results[index] = { ...match.result, baselined: match.baselined, file };
      baselined += match.baselined;
      fixed += match.fixed;
    }
    const moved = new Set(moves.values());
    for (const key of gone) {
      const rules = baseline.entries.get(key);
      if (rules && !moved.has(key) && covered(key)) {
        fixed += countBaseline(new Map([[key, rules]])).findings;
      }
    }
  }
  const elsewhere = results.filter((r) => r.skipped).length;
  if (elsewhere) {
    notes.push(`${plural(elsewhere, 'image or email file')} not checked`);
  }

  // Components the model leaves out were not checked: say so once, not in every file.
  const unchecked = uncheckedNotice(results);

  if (update) {
    const next = updateBaseline(
      baseline?.entries,
      checked,
      realRoot,
      (key) => disabledByKey.get(key) ?? new Set(),
    );
    const wholeRoot = folders.some((dir) => isInside(dir, realRoot));
    writeBaseline(baselineFile, next, {
      onsystem: VERSION,
      // One list for the whole baseline: in a workspace, a rule that ran in one project counts
      // as run in all of them.
      rules: rulesRun(baseline, next, checked, ran, wholeRoot),
    });
    const counts = countBaseline(next);
    const summary = `Baseline: ${count(counts.findings, 'finding')} in ${count(counts.files, 'file')} → ${displayPath(io.cwd, baselineFile)}`;
    // On stderr unless pretty: JSON and SARIF on stdout must parse.
    if (format === 'pretty') io.stdout(summary);
    else io.stderr(summary);
    for (const text of selection.notices) io.stderr(text);
    if (unchecked) io.stderr(unchecked);
    if (jsx) io.stderr(jsx);
    return 0;
  }

  const baselineNotes: string[] = [];
  if (baseline) {
    const fresh = results.flatMap((r) => r.diagnostics);
    const unrecorded = unrecordedRules(baseline, fresh);
    if (unrecorded.size) {
      baselineNotes.push(
        unrecordedNote(unrecorded, fresh.length, baseline.onsystem, command('--update-baseline')),
      );
    }
  }
  if (prune && baseline) {
    // Only drops entries, and moves those of a moved file: a new finding is still reported, and
    // still fails the check.
    const next = pruneBaseline(
      baseline.entries,
      checked,
      realRoot,
      (key) => disabledByKey.get(key) ?? new Set(),
      moves,
    );
    const left = countBaseline(next);
    const dropped = countBaseline(baseline.entries).findings - left.findings;
    if (dropped || moves.size) {
      writeBaseline(baselineFile, next, { onsystem: baseline.onsystem, rules: baseline.rules });
    }
    const done = [
      moves.size
        ? `moved the findings of ${count(moves.size, 'file')} to ${moves.size === 1 ? 'its new path' : 'their new paths'}`
        : '',
      dropped
        ? `dropped ${count(dropped, 'finding')} that no longer ${dropped === 1 ? 'occurs' : 'occur'}`
        : '',
    ].filter(Boolean);
    baselineNotes.push(
      `Baseline: ${done.join('; ') || 'nothing to drop'}; ${count(left.findings, 'finding')} in ${count(left.files, 'file')} → ${displayPath(io.cwd, baselineFile)}`,
    );
  } else if (moves.size) {
    baselineNotes.push(movedNote(moves, command('--prune-baseline')));
  }

  const output = formatDiagnostics(
    format === 'json' ? results : results.filter((r) => !r.skipped),
    format,
    {
      color: io.color,
      uri:
        format === 'sarif' || format === 'github'
          ? repositoryPath(io.cwd, io.env ?? process.env)
          : undefined,
      baselined: baseline ? baselined : undefined,
      notes,
      // `--prune-baseline`, not `--update-baseline`, which would also accept any new finding.
      fixedHint:
        fixed && !prune
          ? `${count(fixed, 'baseline finding')} no longer ${fixed === 1 ? 'occurs' : 'occur'}: run \`${command('--prune-baseline')}\` to drop ${fixed === 1 ? 'it' : 'them'}.`
          : undefined,
    },
  );
  if (output) io.stdout(output);
  for (const text of baselineNotes) {
    if (format === 'pretty') io.stdout(text);
    else if (format === 'github') io.stdout(`::notice title=${NAME} baseline::${escapeData(text)}`);
    else io.stderr(text);
  }
  for (const text of [...selection.notices, unchecked, jsx]) {
    if (text) notify(text);
  }

  const errors = results.reduce((n, r) => n + r.errorCount, 0);
  const warnings = results.reduce((n, r) => n + r.warningCount, 0);
  if (errors > 0) return 1;
  if (maxWarnings !== undefined && warnings > maxWarnings) {
    if (format === 'pretty') io.stderr(`Too many warnings (${warnings}, max ${maxWarnings}).`);
    return 1;
  }
  return 0;
}

/** What `json` and `sarif` print when there is nothing to report on: `[]`, or a log without results. */
function printNoResults(format: OutputFormat, io: Io): void {
  if (format === 'json') io.stdout('[]');
  else if (format === 'sarif') io.stdout(formatDiagnostics([], 'sarif'));
}

/**
 * Maps a path relative to the working directory to one relative to the repository root, which
 * GitHub resolves workflow command annotations (`--format github`) and code scanning locations
 * (`--format sarif`) against, so `check` run from `apps/web` still reports
 * `apps/web/app/page.tsx`. The root is GITHUB_WORKSPACE or the git top-level, whichever is the
 * innermost folder holding the file: the git top-level outside Actions, GITHUB_WORKSPACE where
 * git is missing or refuses the checkout, and the repository checked out in a folder of the
 * workspace (`actions/checkout` with `path:`). A file under neither keeps its path relative to
 * the working directory.
 */
function repositoryPath(cwd: string, env: NonNullable<Io['env']>): (file: string) => string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  const top = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  const roots = [top, env.GITHUB_WORKSPACE ?? '']
    .filter(Boolean)
    .map((dir) => realPath(path.resolve(cwd, dir)))
    // The innermost first: where both hold the file, one is inside the other.
    .sort((a, b) => b.length - a.length);
  if (!roots.length) return toPosix;
  return (file) => {
    const absolute = realPath(path.resolve(cwd, file));
    const root = roots.find((dir) => isInside(dir, absolute));
    return root ? relativePath(root, absolute) : toPosix(file);
  };
}

/**
 * Splits the patterns into files named outright and globs (a folder: every TSX/JSX file under
 * it). `scripts` globs the `.js` files under the folders, which are not checked, to say which
 * of them have JSX.
 */
function expandPatterns(
  patterns: string[],
  cwd: string,
): { named: string[]; globs: string[]; scripts: string[] } {
  // An existing path is taken literally, so `app/(marketing)` and `[slug]` are not
  // glob syntax. A directory means every TSX/JSX file under it.
  const named: string[] = [];
  const globs: string[] = [];
  const scripts: string[] = [];
  for (const pattern of patterns) {
    const stat = fs.statSync(path.resolve(cwd, pattern), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) {
      named.push(path.resolve(cwd, pattern));
      continue;
    }
    const literal = stat ? escapePath(toPosix(path.join(pattern, '.'))) : toPosix(pattern);
    if (!stat) {
      globs.push(literal);
      continue;
    }
    const under = literal === '.' ? '**/*' : `${literal}/**/*`;
    globs.push(`${under}.{tsx,jsx}`);
    scripts.push(`${under}.js`);
  }
  return { named, globs, scripts };
}

/** A `.js` file larger than this is a bundle or generated, not a page: not read for JSX. */
const MAX_PAGE_BYTES = 512 * 1024;

/**
 * `.js` files the folders hold that have JSX, which are not checked: folders expand to TSX and
 * JSX files, and a JavaScript app writes its pages as `.js` (Next.js's JavaScript template has
 * `app/page.js`). Files the run checks anyway (a glob names them), what git ignores and what
 * `leftOut` says (the config's `exclude`, the design system's own files) are not counted, nor
 * are minified files and files over 512 KB, which are bundles rather than pages.
 */
async function jsxLeftOut(
  scripts: string[],
  taken: readonly string[],
  cwd: string,
  leftOut: (file: string) => boolean | Promise<boolean>,
): Promise<string[]> {
  if (!scripts.length) return [];
  const checked = new Set(taken.map(realPath));
  const found = oncePerFile(
    (
      await findFiles(scripts, {
        cwd,
        absolute: true,
        expandDirectories: false,
        ignore: ['**/node_modules/**', '**/*.min.js'],
      })
    ).filter((file) => !checked.has(realPath(file))),
  ).sort();
  const ignored = gitIgnored(cwd, found);
  const files: string[] = [];
  for (const file of found) {
    if (ignored.has(file) || (await leftOut(file))) continue;
    // Only a notice depends on it: a file that cannot be read is left out, not a failed run.
    let code: string;
    try {
      if (fs.statSync(file).size > MAX_PAGE_BYTES) continue;
      code = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (hasJsx(code)) files.push(file);
  }
  return files;
}

/**
 * Where a JSX element can start: after `(`, `,`, `=`, `=>`, `?` (not a regex's `(?<name>`), `:`,
 * `[`, `{`, `&`, `|`, `return`, `yield`, `await` or `default`, with spaces and short comments
 * between. Plain JavaScript has a `<` and a name there only in strings and comments.
 */
const JSX_START =
  /(?:(?<!\()\?|=>|[(,=:[{&|]|\b(?:return|yield|await|default))(?:\s|\/\/[^\n]{0,200}\n|\/\*(?:[^*]|\*(?!\/)){0,500}\*\/)*<([A-Za-z][\w.:-]*|>(?=[\s<{]))/g;

/**
 * Whether the code may have JSX: an element starts where only JSX can start one, and it is a
 * fragment, its closing tag is there, or a `/>` follows it. A library bundle whose strings hold
 * HTML rarely passes, so most `.js` files are never parsed.
 */
function mayHaveJsx(code: string): boolean {
  for (const match of code.matchAll(JSX_START)) {
    const name = match[1] ?? '';
    if (name === '>' || code.includes(`</${name}>`)) return true;
    const from = match.index + match[0].length;
    const close = code.indexOf('/>', from);
    if (close >= 0 && close - from < 2000) return true;
  }
  return false;
}

/** Whether the code has a JSX element or fragment. */
function hasJsx(code: string): boolean {
  if (!code.includes('/>') && !code.includes('</')) return false;
  if (!mayHaveJsx(code)) return false;
  const source = ts.createSourceFile(
    'file.js',
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JSX,
  );
  const visit = (node: ts.Node): boolean =>
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node) ||
    ts.forEachChild(node, visit) === true;
  try {
    return visit(source);
  } catch {
    // Nested too deeply to walk: not a page anyone wrote.
    return false;
  }
}

/** Which `.js` files with JSX the folders left out, and the command that checks them. */
function jsxNotice(
  selection: Pick<Selection, 'jsx' | 'jsxGlobs'>,
  cwd: string,
  command: (flag: string) => string,
): string | undefined {
  const files = selection.jsx.map((file) => relativePath(cwd, file));
  if (!files.length) return undefined;
  const check = command(selection.jsxGlobs.map(shellQuote).join(' '));
  return files.length === 1
    ? `${files[0] ?? ''} has JSX, but folders are checked for .tsx and .jsx files, so it was not checked. Name it to check it: \`${check}\`.`
    : `${files.length.toLocaleString('en-US')} .js files have JSX (${listOf(files)}), but folders are checked for .tsx and .jsx files, so they were not checked. Name them to check them: \`${check}\`.`;
}

/** One project: the root's config and design system for every file. */
async function selectInProject(
  config: ResolvedConfig,
  patterns: string[],
  values: CheckValues,
  format: OutputFormat,
  io: Io,
): Promise<Selection | NoMatch | number> {
  const ds = await loadDesignSystem(config, { cache: values.cache, logger: silentLogger });
  // Folders and globs leave out what the config excludes (tests and stories by default) and
  // what git ignores. A file named outright is checked, unless --skip-excluded. Only JS and TS
  // files are: `check $(git diff --name-only)` and `check "**/*"` name styles and docs too.
  const { named: given, globs, scripts } = expandPatterns(patterns, io.cwd);
  const options = { cwd: io.cwd, absolute: true, expandDirectories: false };
  const globbed = globs.length
    ? await findFiles(globs, { ...options, ignore: ['**/node_modules/**'] })
    : [];
  const named = given.filter((file) => SCRIPT_FILE.test(file));
  const all = globbed.filter((file) => SCRIPT_FILE.test(file));
  const excluded = (file: string) =>
    excludedBy(config, relativePath(config.root, file), {
      includeTests: values['include-tests'],
    }) !== undefined;
  // The design system's own files implement the scale and the primitives the
  // rules enforce (shadcn/ui's `p-[3px]`), so `check .` leaves them alone.
  const ownFiles = async () =>
    new Set(config.includeDesignSystem ? [] : (await componentFiles(config)).map(realPath));
  // `.js` files with JSX in the folders, left out as their `.tsx` files would be.
  const jsxIn = (taken: readonly string[], own: Set<string>) =>
    jsxLeftOut(scripts, taken, io.cwd, (file) => excluded(file) || own.has(realPath(file)));
  const skip = values['skip-excluded'];
  const leftOut = unique([...(skip ? named : []), ...all]).filter(excluded);
  const leftOutSet = new Set(leftOut);
  const kept = all.filter((file) => !leftOutSet.has(file));
  const ignored = gitIgnored(io.cwd, kept);
  const left = {
    tests: leftOut.filter((file) => TEST_FILE.test(file)).length,
    excluded: leftOut.filter((file) => !TEST_FILE.test(file)).length,
    gitignored: ignored.size,
    notScripts: notScripts(given, globbed),
  };
  let files = oncePerFile([
    ...(skip ? named.filter((file) => !leftOutSet.has(file)) : named),
    ...kept.filter((file) => !ignored.has(file)),
  ]).sort();
  if (!files.length && !all.length && !leftOut.length && !left.notScripts) {
    const jsx = scripts.length ? await jsxIn([], await ownFiles()) : [];
    return { noMatch: true, jsx, jsxGlobs: scripts };
  }

  // A hook installed for every project should not lint React apps that have no
  // design system. Tokens alone are not one: Tailwind's default scale, or the three
  // stray custom properties of an app styled with CSS-in-JS (twenty), would block an
  // agent on rules that have nothing to compare against.
  if (values['quiet-without-design-system'] && !config.configFile && !ds.components.length) {
    printNoResults(format, io);
    return 0;
  }

  // A run that found no components or no color tokens passes without having
  // checked them: say so, and fail in CI when asked to, unless the components come from a
  // published library (MUI), whose colors may be in Sass: then it only says so.
  const notice = ds.notice();
  if (notice && values['require-design-system'] && !ds.hasDesignSystem()) {
    io.stderr(`check --require-design-system: ${notice}`);
    for (const text of notReadNotices([{ ds }])) io.stderr(text);
    return 2;
  }

  let skipped = 0;
  const own = await ownFiles();
  if (own.size) {
    const rest = files.filter((file) => !own.has(realPath(file)));
    skipped = files.length - rest.length;
    files = rest;
  }
  const jsx = await jsxIn([...named, ...all], own);
  return {
    files,
    designSystemOf: () => ds,
    root: ds.root,
    notes: scopeNotes(skipped, left),
    notices: [...(notice ? [notice] : []), ...notReadNotices([{ ds }])],
    skipped,
    testsLeftOut: left.tests,
    jsx,
    jsxGlobs: scripts,
    searched: globs.length > 0,
  };
}

/**
 * A workspace root: each file is checked by the design system of its own project, the
 * nearest folder with a config, a components.json or a package.json, with that project's
 * config, exactly as `check` from that folder (and the Claude Code hook) would check it.
 */
async function selectInWorkspace(
  workspace: Workspace,
  patterns: string[],
  values: CheckValues,
  format: OutputFormat,
  io: Io,
): Promise<Selection | NoMatch | number> {
  const { named: given, globs, scripts } = expandPatterns(patterns, io.cwd);
  const globbed = globs.length
    ? await findFiles(globs, {
        cwd: io.cwd,
        absolute: true,
        expandDirectories: false,
        ignore: ['**/node_modules/**'],
      })
    : [];
  const named = given.filter((file) => SCRIPT_FILE.test(file));
  const all = globbed.filter((file) => SCRIPT_FILE.test(file));
  const projectOf = new Map<string, Project>();
  for (const file of unique([...named, ...all])) {
    projectOf.set(file, await workspace.projectFor(file));
  }
  const project = (file: string): Project => {
    const found = projectOf.get(file);
    if (!found) throw new Error(`No project for ${file}`);
    return found;
  };
  const designSystems = new Map<string, Promise<DesignSystem>>();
  const load = (p: Project) => {
    let ds = designSystems.get(p.root);
    if (!ds) {
      ds = loadDesignSystem(p.config, { cache: values.cache, logger: silentLogger });
      designSystems.set(p.root, ds);
    }
    return ds;
  };

  // Each project's `exclude` applies to its own files, relative to its folder, as `check` there
  // applies it.
  const excluded = (file: string) => {
    const { root, config } = project(file);
    const relative = relativePath(root, file);
    return excludedBy(config, relative, { includeTests: values['include-tests'] }) !== undefined;
  };
  const skip = values['skip-excluded'];
  const leftOut = unique([...(skip ? named : []), ...all]).filter(excluded);
  const leftOutSet = new Set(leftOut);
  const kept = all.filter((file) => !leftOutSet.has(file));
  const ignored = gitIgnored(io.cwd, kept);
  const left = {
    tests: leftOut.filter((file) => TEST_FILE.test(file)).length,
    excluded: leftOut.filter((file) => !TEST_FILE.test(file)).length,
    gitignored: ignored.size,
    notScripts: notScripts(given, globbed),
  };
  let files = oncePerFile([
    ...(skip ? named.filter((file) => !leftOutSet.has(file)) : named),
    ...kept.filter((file) => !ignored.has(file)),
  ]).sort();

  // A project's design-system files implement its scale and primitives. Only a file's own
  // project counts: a package's files are checked as `check` in its folder checks them,
  // even when an app uses them as its design system.
  const own = new Map<string, Set<string>>();
  const ownFiles = async (p: Project) => {
    let mine = own.get(p.root);
    if (!mine) {
      mine = new Set(
        p.config.includeDesignSystem ? [] : (await componentFiles(p.config)).map(realPath),
      );
      own.set(p.root, mine);
    }
    return mine;
  };
  // `.js` files with JSX, each left out as `check` in its own project leaves it out.
  const jsxIn = (taken: readonly string[]) =>
    jsxLeftOut(scripts, taken, io.cwd, async (file) => {
      const p = await workspace.projectFor(file);
      projectOf.set(file, p);
      return excluded(file) || (await ownFiles(p)).has(realPath(file));
    });

  if (!files.length && !all.length && !leftOut.length && !left.notScripts) {
    return { noMatch: true, jsx: await jsxIn([]), jsxGlobs: scripts };
  }

  const loaded = new Map<string, DesignSystem>();
  for (const p of unique(files.map(project))) loaded.set(p.root, await load(p));
  const designSystemOf = (file: string): DesignSystem => {
    const ds = loaded.get(project(file).root);
    if (!ds) throw new Error(`No design system loaded for ${file}`);
    return ds;
  };

  // The hook's rule, per project: no config and no components, nothing to say.
  if (values['quiet-without-design-system']) {
    files = files.filter(
      (file) =>
        Boolean(project(file).config.configFile) || designSystemOf(file).components.length > 0,
    );
    if (!files.length) {
      printNoResults(format, io);
      return 0;
    }
  }

  // At a root, the gate is that some project has components and color tokens to check against,
  // or components from a published library (MUI).
  if (values['require-design-system']) {
    let complete = false;
    for (const p of workspace.projects) {
      if ((await load(p)).hasDesignSystem()) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      const packages = workspace.projects.length + workspace.others.length;
      io.stderr(
        `check --require-design-system: no workspace package has a design system with components and color tokens (${plural(packages, 'package')} looked at). See ${DOCS}/troubleshooting`,
      );
      return 2;
    }
  }

  for (const p of unique(files.map(project))) await ownFiles(p);
  const rest = files.filter((file) => !own.get(project(file).root)?.has(realPath(file)));
  const skipped = files.length - rest.length;
  files = rest;

  const jsx = await jsxIn([...named, ...all]);

  // What could not run, once per kind of gap, naming the projects.
  const gaps = new Map<string, { ds: DesignSystem; dirs: string[] }>();
  for (const p of unique(files.map(project))) {
    const ds = loaded.get(p.root);
    const notice = ds?.notice();
    if (!ds || !notice) continue;
    const gap = gaps.get(notice) ?? { ds, dirs: [] };
    gap.dirs.push(p.dir);
    gaps.set(notice, gap);
  }
  const notices = [...gaps.values()].map(({ ds, dirs }) => ds.notice(listOf(dirs)) ?? '');
  const checkedProjects = unique(files.map(project)).flatMap((p) => {
    const ds = loaded.get(p.root);
    return ds ? [{ ds, dir: p.dir }] : [];
  });
  notices.push(...notReadNotices(checkedProjects));
  const used = unique(files.map((file) => project(file).root)).length;
  return {
    files,
    designSystemOf,
    root: workspace.root,
    notes: [...(used > 1 ? [plural(used, 'project')] : []), ...scopeNotes(skipped, left)],
    notices: notices.filter(Boolean),
    skipped,
    testsLeftOut: left.tests,
    jsx,
    jsxGlobs: scripts,
    searched: globs.length > 0,
  };
}

/** `apps/web`, `apps/web and packages/ui`, `a, b, c and 4 more`. */
function listOf(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length <= max) return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

async function inspect(
  configOptions: LoadConfigOptions,
  values: { cache: boolean; format?: string | undefined; explain: boolean },
  io: Io,
): Promise<number> {
  const target = await loadTarget(configOptions);
  const { config } = target;
  warnDeprecated(config.deprecations, 'pretty', io);
  warnDeprecated(configWarnings(target), 'pretty', io);
  if (target.workspace) return inspectWorkspace(target.workspace, values, io);
  const ds = await loadDesignSystem(config, { cache: values.cache, logger: silentLogger });
  const { model } = ds;
  if (values.format === 'json') {
    io.stdout(JSON.stringify(model, null, 2));
    return 0;
  }
  const lines: string[] = [
    `root     ${model.root}`,
    `config   ${config.configFile ? `${displayPath(io.cwd, config.configFile)}${declaredBy(config)}` : '(defaults)'}`,
    ...(config.detected ? [`detected ${config.detected}`] : []),
    ...describeLibraries(config, model, io.cwd).map((line) => `library  ${line}`),
    `files    ${plural(model.stats.files.components, 'component file')}, ${plural(model.stats.files.tokens, 'token file')}, ${plural(model.stats.files.docs, 'doc')}`,
    `time     ${model.stats.durationMs}ms${model.stats.fromCache ? ' (cache)' : ''}`,
    '',
    `Components (${ds.roots().length} + ${ds.components.length - ds.roots().length} parts)`,
  ];
  for (const c of ds.roots()) {
    const variants = c.variants.map((v) => `${v.name}[${v.values.length}]`).join(' ');
    const meta = [
      c.element ? `<${c.element}>` : '',
      plural(c.props.length, 'prop'),
      variants,
      c.subcomponents.length ? plural(c.subcomponents.length, 'part') : '',
      c.docs ? 'docs' : '',
      plural(c.examples.length, 'example'),
    ].filter(Boolean);
    lines.push(`  ${c.name.padEnd(18)} ${meta.join(' · ')}`);
  }
  lines.push('', `Tokens (${model.tokens.length})`);
  for (const [category, n] of tokenCounts(model)) lines.push(`  ${category.padEnd(18)} ${n}`);
  if (model.warnings.length) {
    lines.push('', 'Warnings');
    for (const warning of model.warnings) lines.push(`  ${warning}`);
  }
  if (values.explain) lines.push('', ...explainProject(ds, io.cwd));
  io.stdout(lines.join('\n'));
  const missing = values.explain ? undefined : missingDependencies([{ ds }]);
  if (missing) io.stderr(missing);
  return 0;
}

/**
 * `MUI (@mui/material 9.4.0): 149 components from its type declarations`, per library the
 * project depends on, including those the config's `libraries` leaves out.
 */
function describeLibraries(
  config: ResolvedConfig,
  model: DesignSystemModel,
  cwd: string,
): string[] {
  const name = (library: LibrarySource) =>
    `${libraryTitle(library.package)} (${library.package}${library.version ? ` ${library.version}` : ''})`;
  return [
    ...(config.libraries ?? []).map((library) => {
      if (!library.dir) return `${name(library)}: a dependency, but not installed`;
      const count = model.components.filter((c) => c.library === library.package).length;
      return `${name(library)}: ${plural(count, 'component')} from its type declarations`;
    }),
    ...(config.librariesOff ?? []).map(
      (library) => `${name(library)}: ${librariesLeftOut(config, cwd)}`,
    ),
    ...(config.librariesUnread ?? []).map((library) => `${name(library)}: ${notReadYet()}`),
  ];
}

/**
 * `export --format dtcg|design-md`: the project's tokens as a DTCG 2025.10 file or a
 * DESIGN.md, on stdout or in the `--out` file.
 */
async function exportTokens(
  configOptions: LoadConfigOptions,
  values: { cache: boolean; format?: string | undefined; out?: string | undefined },
  io: Io,
): Promise<number> {
  const format = values.format;
  if (format !== 'dtcg' && format !== 'design-md') {
    io.stderr(
      `export: pass --format dtcg or --format design-md${format === undefined ? '' : ` (not "${format}")`}`,
    );
    return 2;
  }
  const target = await loadTarget(configOptions);
  warnDeprecated(target.config.deprecations, 'pretty', io);
  warnDeprecated(configWarnings(target), 'pretty', io);
  if (target.workspace) {
    const dirs = target.workspace.projects.map((p) => p.dir);
    io.stderr(
      `export: ${target.workspace.root} is a monorepo root, and each project has its own tokens. Pass --root with one of them${dirs.length ? ` (${listOf(dirs)})` : ''}.`,
    );
    return 2;
  }
  const ds = await loadDesignSystem(target.config, { cache: values.cache, logger: silentLogger });
  if (!ds.tokens.length) {
    io.stderr(
      `export: no design tokens found in ${ds.root}. \`${NAME} inspect --explain\` shows where it looked.`,
    );
    return 2;
  }
  const result =
    format === 'dtcg' ? toDtcg(ds.tokens) : toDesignMd(ds.tokens, { name: projectName(ds.root) });
  for (const warning of result.warnings) io.stderr(`export: ${warning}`);
  if (values.out === undefined) {
    io.stdout(result.text.trimEnd());
    return 0;
  }
  const file = path.resolve(io.cwd, values.out);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, result.text);
  io.stdout(
    `Wrote ${plural(result.count, 'token')} to ${displayPath(io.cwd, file)} (${format === 'dtcg' ? 'DTCG 2025.10' : 'DESIGN.md'})`,
  );
  return 0;
}

/** The package name in the root's package.json, else the folder's name. */
function projectName(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name) return pkg.name;
  } catch {
    // No package.json, or not one we can read.
  }
  return path.basename(root);
}

function tokenCounts(model: DesignSystemModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of model.tokens) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  return counts;
}

/** Every project of a workspace root, with what was found in each, and the packages without one. */
async function inspectWorkspace(
  workspace: Workspace,
  values: { cache: boolean; format?: string | undefined; explain: boolean },
  io: Io,
): Promise<number> {
  const loaded = [];
  for (const project of workspace.projects) {
    loaded.push({
      project,
      ds: await loadDesignSystem(project.config, { cache: values.cache, logger: silentLogger }),
    });
  }
  if (values.format === 'json') {
    io.stdout(
      JSON.stringify(
        {
          root: workspace.root,
          workspace: workspace.source,
          projects: loaded.map(({ project, ds }) => ({
            dir: project.dir,
            ...(project.name ? { name: project.name } : {}),
            ...(project.config.configFile
              ? { config: relativePath(workspace.root, project.config.configFile) }
              : {}),
            ...(project.config.detected ? { detected: project.config.detected } : {}),
            model: ds.model,
          })),
          others: workspace.others,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const packages = workspace.projects.length + workspace.others.length;
  const lines: string[] = [
    `root      ${workspace.root}`,
    `workspace ${plural(packages, 'package')} (${workspace.source}), ${plural(workspace.projects.length, 'project')} with a design system`,
    `config    ${workspace.configFile ? displayPath(io.cwd, workspace.configFile) : '(defaults)'}`,
  ];
  for (const { project, ds } of loaded) {
    const { model } = ds;
    const roots = ds.roots();
    const tokens = [...tokenCounts(model)].map(([category, n]) => `${category} ${n}`);
    const own =
      project.config.configFile && project.config.configFile !== workspace.configFile
        ? `${displayPath(workspace.root, project.config.configFile)}${declaredBy(project.config)}`
        : undefined;
    lines.push(
      '',
      `${project.dir}${project.name ? ` (${project.name})` : ''}`,
      ...(own ? [`  config     ${own}`] : []),
      ...(project.config.detected ? [`  detected   ${project.config.detected}`] : []),
      ...describeLibraries(project.config, model, io.cwd).map((line) => `  library    ${line}`),
      `  files      ${plural(model.stats.files.components, 'component file')}, ${plural(model.stats.files.tokens, 'token file')}, ${plural(model.stats.files.docs, 'doc')}`,
      `  components ${roots.length} + ${ds.components.length - roots.length} parts${roots.length ? `: ${listNames(roots.map((c) => c.name))}` : ''}`,
      `  tokens     ${tokens.length ? tokens.join(', ') : 'none'}`,
      ...(model.warnings.length
        ? [`  warnings   ${model.warnings.length}: ${model.warnings[0] ?? ''}`]
        : []),
    );
  }
  if (!loaded.length) {
    lines.push(
      '',
      `No workspace package has a design system that zero config finds. See ${DOCS}/troubleshooting`,
    );
  }
  if (workspace.others.length) {
    lines.push(
      '',
      `Without a design system (${workspace.others.length}): ${listNames(workspace.others)}`,
    );
  }
  lines.push(
    '',
    `Each file is checked by its project's design system. For one project's components, tokens and warnings: ${NAME} inspect --root <folder>`,
  );
  if (values.explain) lines.push('', ...explainWorkspace(workspace, loaded, io.cwd));
  io.stdout(lines.join('\n'));
  const missing = values.explain
    ? undefined
    : missingDependencies(loaded.map(({ project, ds }) => ({ ds, dir: project.dir })));
  if (missing) io.stderr(missing);
  return 0;
}

/** Why the root is read as a monorepo, then each project's explanation. */
function explainWorkspace(
  workspace: Workspace,
  loaded: { project: Project; ds: DesignSystem }[],
  cwd: string,
): string[] {
  const { rootConfig } = workspace;
  const steps: DetectionStep[] = [];
  detectProject(rootConfig.root, rootConfig.tsconfig, steps);
  const lines = [
    `Why this is read as a monorepo root: it declares workspace packages (${workspace.source}), no config there sets components, and zero config finds no design system in the root itself:`,
    ...steps.map((s) => `  ${(s.accepted ? 'found' : 'no').padEnd(6)} ${s.candidate}: ${s.reason}`),
    `  no     ${rootConfig.components.join(', ')}: no file matches`,
  ];
  for (const { project, ds } of loaded) {
    lines.push(
      '',
      `${project.dir}${project.name ? ` (${project.name})` : ''}`,
      ...explainProject(ds, cwd, '  '),
    );
  }
  return lines;
}

/** ` (declared by @acme/ui)` after a config a design-system package declares; empty otherwise. */
function declaredBy(config: ResolvedConfig): string {
  return config.designSystemPackage ? ` (declared by ${config.designSystemPackage.name})` : '';
}

/** `A, B, C` up to a dozen names, then `and 40 more`. */
function listNames(names: readonly string[], max = 12): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

/**
 * Says once what a file's old name means: on stderr, or as a workflow warning with
 * `--format github` so it shows on the run. Never on stdout otherwise, which JSON output owns.
 */
/** What the configs read have to say: the project's, or every package's at a monorepo root. */
function configWarnings(target: {
  config: ResolvedConfig;
  workspace?: Workspace | undefined;
}): string[] | undefined {
  return target.workspace ? target.workspace.warnings : target.config.warnings;
}

function warnDeprecated(messages: string[] | undefined, format: string, io: Io): void {
  for (const text of messages ?? []) {
    if (format === 'github') io.stdout(`::warning title=${NAME}::${text}`);
    else io.stderr(text);
  }
}

/**
 * The baseline in the root: `onsystem.baseline.json`, or one still under its name from
 * before the rename, which is read (and updated) where it is, with a notice to rename it.
 */
function defaultBaseline(root: string, warn: ((text: string) => void) | undefined): string {
  const current = path.join(root, BASELINE_FILE);
  const legacy = path.join(root, LEGACY_BASELINE_FILE);
  if (!fs.existsSync(legacy)) return current;
  if (fs.existsSync(current)) {
    warn?.(
      `${LEGACY_BASELINE_FILE} is ignored: ${BASELINE_FILE} is read instead. Delete ${LEGACY_BASELINE_FILE}.`,
    );
    return current;
  }
  warn?.(
    `${LEGACY_BASELINE_FILE} is the baseline's name from before design-system-mcp became onsystem. Rename it to ${BASELINE_FILE} (git mv ${LEGACY_BASELINE_FILE} ${BASELINE_FILE}); the old name still works for now.`,
  );
  return legacy;
}

/** Tests and stories, which `check` leaves out of folders and globs unless asked. */
const TEST_FILE = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|[\\/]__(?:tests|stories|mocks)__[\\/]/;

/**
 * How many of the files named outright or matched by a glob are not JS or TS (styles, docs,
 * JSON), which are not checked.
 */
function notScripts(named: readonly string[], globbed: readonly string[]): number {
  return oncePerFile([...named, ...globbed].filter((file) => !SCRIPT_FILE.test(file))).length;
}

/** What a run left out, for the summary line: `5 design-system files skipped`. */
function scopeNotes(
  skipped: number,
  left: { tests: number; excluded: number; gitignored: number; notScripts: number },
): string[] {
  return [
    skipped ? `${plural(skipped, 'design-system file')} skipped` : '',
    left.tests
      ? `${left.tests.toLocaleString('en-US')} ${left.tests === 1 ? 'test or story' : 'tests and stories'} left out`
      : '',
    left.excluded ? `${plural(left.excluded, 'excluded file')} left out` : '',
    left.gitignored ? `${plural(left.gitignored, 'file')} git ignores left out` : '',
    left.notScripts
      ? `${plural(left.notScripts, 'file')} that ${left.notScripts === 1 ? 'is' : 'are'} not JS or TS skipped`
      : '',
  ].filter(Boolean);
}

/**
 * Files a glob matches, as Node spells absolute paths (with backslashes on Windows, where
 * tinyglobby gives forward slashes), so they compare equal to `path.resolve` and git's.
 */
async function findFiles(globs: string[], options: GlobOptions): Promise<string[]> {
  return (await glob(globs, options)).map((file) => path.resolve(file));
}

/**
 * The files git ignores, through `git check-ignore`: nested .gitignore files,
 * `.git/info/exclude` and tracked-file exceptions, exactly as git reads them.
 * Outside a repository, or without git, nothing is ignored.
 */
function gitIgnored(cwd: string, files: readonly string[]): Set<string> {
  if (!files.length) return new Set();
  const result = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd,
    input: files.join('\0'),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  // 0: some are ignored, 1: none are, anything else: not a repository or no git.
  if (result.status !== 0 || typeof result.stdout !== 'string') return new Set();
  return new Set(
    result.stdout
      .split('\0')
      .filter(Boolean)
      .map((file) => path.resolve(cwd, file)),
  );
}

/** `1,307 findings`. */
function count(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : `${word}s`}`;
}

/**
 * `check` as this run was given, with `flag`: the patterns and the options that decide what it
 * finds and which baseline it reads (output options left out).
 */
function checkCommand(
  patterns: string[],
  configOptions: LoadConfigOptions,
  values: CheckValues,
  flag: string,
): string {
  const args = [...patterns];
  const option = (name: string, value: string | undefined) => {
    if (value !== undefined) args.push(`--${name}`, value);
  };
  option('root', configOptions.root);
  option('config', configOptions.config);
  for (const name of ['components', 'tokens', 'docs'] as const) {
    for (const value of configOptions[name] ?? []) option(name, value);
  }
  option('baseline', values.baseline);
  if (configOptions.includeDesignSystem !== undefined) {
    args.push(`--${configOptions.includeDesignSystem ? '' : 'no-'}include-design-system`);
  }
  if (values['include-tests']) args.push('--include-tests');
  if (values['skip-excluded']) args.push('--skip-excluded');
  return `check ${args.map(shellQuote).join(' ')} ${flag}`;
}

/**
 * Whether a rule has something to compare against in a design system, as `notice()` says when
 * it has not: no-hardcoded-color needs color tokens, the spacing and radius rules tokens of
 * their kind, and the component rules components. Keep it in step with `DesignSystem.notice()`
 * in src/design-system.ts, or the baseline records a rule as run when it was skipped, or the
 * other way round.
 */
function canRun(ds: DesignSystem, rule: RuleId): boolean {
  switch (rule) {
    case 'no-hardcoded-color':
      return ds.tokenIndex.has('color');
    case 'no-hardcoded-spacing':
      return ds.tokenIndex.has('spacing');
    case 'no-hardcoded-radius':
      return ds.tokenIndex.has('radius');
    case 'icon-button-accessible-name':
      return true;
    default:
      return ds.model.components.length > 0;
  }
}

/** Says which files the baseline takes for moved, and how to record their new paths. */
function movedNote(moves: ReadonlyMap<string, string>, prune: string): string {
  const pairs = [...moves].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const [first] = pairs;
  if (pairs.length === 1 && first) {
    return `Baseline: ${first[0]} has the findings recorded for ${first[1]}, which no longer exists, so they are accepted as moved. Run \`${prune}\` to record the new path.`;
  }
  const list = listOf(pairs.map(([to, from]) => `${from} → ${to}`));
  return `Baseline: ${pairs.length} files have the findings recorded for files that no longer exist, so they are accepted as moved (${list}). Run \`${prune}\` to record the new paths.`;
}

/** The variable the GitHub Action names the pull request's changed lines in. */
const CHANGED_LINES = 'ONSYSTEM_CHANGED_LINES';

/**
 * The lines a pull request changed, by the real path of each file: the JSON file that
 * ONSYSTEM_CHANGED_LINES names maps paths to 1-based ranges, `{ "/repo/app/page.tsx": [[4, 4]] }`.
 * The GitHub Action writes it. Undefined when the variable is not set.
 */
function readChangedLines(
  env: Record<string, string | undefined>,
  cwd: string,
): Map<string, LineRanges> | undefined {
  const file = env[CHANGED_LINES]?.trim();
  if (!file) return undefined;
  // Outside the Action, the variable is most likely left over from a shell or another step.
  const fail = (why: string) =>
    new ConfigError(
      `${CHANGED_LINES}: ${why}. The GitHub Action sets this variable to a file of the lines a pull request changed; unset it when you run check yourself.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8'));
  } catch (error) {
    throw fail(`could not read ${file}: ${(error as Error).message}`);
  }
  const range = (value: unknown): value is [number, number] =>
    Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw fail(`${file} must map files to line ranges`);
  }
  const lines = new Map<string, LineRanges>();
  for (const [name, ranges] of Object.entries(parsed)) {
    if (!Array.isArray(ranges) || !ranges.every(range)) {
      throw fail(`${file} › "${name}" must be a list of [start, end] lines`);
    }
    lines.set(realPath(path.resolve(cwd, name)), ranges);
  }
  return lines;
}

/** Why findings of rules that did not run when the baseline was recorded are new to it. */
function unrecordedNote(
  byRule: ReadonlyMap<string, number>,
  total: number,
  version: string | undefined,
  update: string,
): string {
  const rules = [...byRule.keys()].sort();
  const n = [...byRule.values()].reduce((sum, k) => sum + k, 0);
  const others = total - n;
  return (
    `${listOf(rules, rules.length)} did not run when the baseline was written${version ? ` (onsystem ${version})` : ''}, ` +
    `so ${rules.length === 1 ? 'its' : 'their'} ${count(n, 'finding')} ${n === 1 ? 'is' : 'are'} new to the baseline, not necessarily to the code. ` +
    `To accept ${n === 1 ? 'it' : 'them'}, run \`${update}\`${others ? `, which also accepts the ${count(others, 'other new finding')}` : ''}.`
  );
}

/** Quotes a pattern for the hint when the shell would expand or split it. */
function shellQuote(pattern: string): string {
  return /^[\w./@-]+$/.test(pattern) ? pattern : `"${pattern.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** The file's real path, so a linked root or a differently spelled path matches. */
function realPath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

/**
 * One path per file, links resolved: a folder that links back to its parent reaches the same
 * files again. The shortest path stays.
 */
function oncePerFile(files: readonly string[]): string[] {
  const kept = new Map<string, string>();
  for (const file of files) {
    const real = realPath(file);
    const previous = kept.get(real);
    if (previous === undefined || file.length < previous.length) kept.set(real, file);
  }
  return [...kept.values()];
}

/** Relative to cwd when the file is below it, absolute otherwise. */
function displayPath(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}
