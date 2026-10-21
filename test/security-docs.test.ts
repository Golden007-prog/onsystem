import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GUIDE_FILE } from '../src/init.js';

// SECURITY.md is what a team reads before it makes onsystem a required check or installs the
// plugin for everyone: how a report is handled, which versions get fixes, how to check a release,
// and everything the tool, the plugin and the Action read, write and run.

const root = path.resolve(import.meta.dirname, '..');
const security = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');

/** The text of a `## heading` section. */
function section(heading: string): string {
  const start = security.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`SECURITY.md has no "## ${heading}"`);
  const end = security.indexOf('\n## ', start + 1);
  return security.slice(start, end === -1 ? undefined : end);
}

describe('SECURITY.md', () => {
  it('says when a report gets a reply, and which versions get fixes', () => {
    expect(section('Reporting a vulnerability')).toContain(
      'You get a reply within 2 working days.',
    );
    expect(section('Supported versions')).toContain('Fixes go to the latest minor release only');
  });

  it('says how to check a release, from the workflow that publishes it', () => {
    const verify = section('Verifying a release');
    expect(verify).toContain('npm audit signatures');
    const workflow = /`(\.github\/workflows\/[\w-]+\.yml)`/.exec(verify)?.[1] ?? '';
    expect(fs.readFileSync(path.join(root, workflow), 'utf8')).toContain('id-token: write');
  });

  it('names every file the tool writes', () => {
    const trusts = section('What the tool trusts');
    for (const written of [
      'node_modules/.cache/onsystem',
      'onsystem-<uid>',
      'check --update-baseline',
      'export --out',
      'onsystem.config.json',
      GUIDE_FILE,
      'package.json',
      'AGENTS.md',
      'CLAUDE.md',
    ]) {
      expect(trusts).toContain(`\`${written}\``);
    }
  });

  it('says what the plugin runs, in every project it is used in', () => {
    const plugin = section('The Claude Code plugin');
    expect(plugin).toContain('use them in repositories you trust');
    expect(plugin).toContain('whatever its version');
    expect(plugin).toContain('`.npmrc`');
  });

  it('says what the Action runs, and how not to run it', () => {
    const action = section('The GitHub Action');
    expect(action).toContain('[required-check.md](docs/required-check.md)');
    expect(action).toContain('`contents: read`');
    expect(action).toContain('Do not run it on `pull_request_target`');
  });
});
