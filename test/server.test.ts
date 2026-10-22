import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  Client as ModernClient,
  InMemoryTransport as ModernInMemoryTransport,
} from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createServer } from '../src/server/index.js';
import { serveStdio } from '../src/server/stdio.js';
import { silentLogger } from '../src/util/log.js';
import { DEMO_ROOT, fixture, load, loadOnce } from './helpers.js';

function text(result: unknown): string {
  const content = (result as CallToolResult).content[0];
  return content?.type === 'text' ? content.text : '';
}

describe('MCP server over the in-memory transport', () => {
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  beforeAll(async () => {
    const ds = await loadOnce(DEMO_ROOT);
    const server = createServer({ getDesignSystem: () => Promise.resolve(ds) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
  });

  it('advertises instructions and five read-only tools with schemas', async () => {
    expect(client.getInstructions()).toContain('Run check_ui on every snippet');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_ui',
      'get_component',
      'get_tokens',
      'list_components',
      'search_components',
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(80);
      // All four hints, explicitly: some clients and directories reject tools that leave one out.
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema.type).toBe('object');
      // The README says every tool has one.
      expect([tool.name, tool.outputSchema?.type]).toEqual([tool.name, 'object']);
    }
    // Integers carry no ±(2^53 - 1) bounds, which every client would read for nothing.
    expect(JSON.stringify(tools)).not.toContain('9007199254740991');
    const component = tools.find((t) => t.name === 'get_component');
    expect(Object.keys(component?.outputSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(['name', 'importPath', 'props', 'variants', 'import', 'tokens']),
    );
    const check = tools.find((t) => t.name === 'check_ui');
    expect(Object.keys(check?.inputSchema.properties ?? {})).toEqual([
      'code',
      'path',
      'filename',
      'limit',
    ]);
    expect(check?.outputSchema?.properties).toHaveProperty('diagnostics');
  });

  it('list_components', async () => {
    const result = await client.callTool({ name: 'list_components', arguments: {} });
    expect(text(result)).toContain('Button <button> — Triggers an action or event');
    expect(text(result)).toContain(
      'variant: default | destructive | outline | secondary | ghost | link (default default)',
    );
    const { components } = result.structuredContent as {
      components: { name: string; variants: object }[];
    };
    expect(components.map((c) => c.name)).toEqual(['Badge', 'Button', 'Card', 'Dialog', 'Input']);
    expect(components[1]?.variants).toEqual({
      variant: ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'],
      size: ['default', 'sm', 'lg', 'icon'],
    });
  });

  it('get_component', async () => {
    const result = await client.callTool({ name: 'get_component', arguments: { name: 'button' } });
    const body = text(result);
    expect(body).toContain('import { Button } from "@/components/ui/button"');
    expect(body).toContain('- asChild?: boolean = false — "Render the child element');
    expect(body).toMatch(
      /…plus \d+ props from React\.ComponentProps<"button"> \(onClick, type, disabled, form, aria-\*/,
    );
    expect(body).toContain(
      '- variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link" = "default"',
    );
    expect(body).toContain('## Variants');
    expect(body).toContain('## Docs (docs/button.md)');
    expect(body).toContain('### "Destructive action"');
    expect(result.structuredContent).toMatchObject({ name: 'Button', element: 'button' });

    const part = await client.callTool({
      name: 'get_component',
      arguments: { name: 'Card.Header' },
    });
    expect(text(part)).toContain('# CardHeader');
    expect(text(part)).toContain('Part of Card');
  });

  it('get_component with an unknown name returns an error with a suggestion', async () => {
    const result = await client.callTool({ name: 'get_component', arguments: { name: 'Buton' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Did you mean "Button"?');
  });

  it('search_components', async () => {
    const result = await client.callTool({
      name: 'search_components',
      arguments: { query: 'confirm a destructive action', limit: 3 },
    });
    expect(text(result)).toMatch(
      /^Components for "confirm a destructive action", best first:\n\n1\. Dialog/,
    );
    const { results } = result.structuredContent as { results: { name: string }[] };
    expect(results[0]?.name).toBe('Dialog');
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('get_tokens', async () => {
    const result = await client.callTool({ name: 'get_tokens', arguments: { category: 'radius' } });
    expect(text(result)).toContain('- radius-md: calc(var(--radius) - 2px) = 8px → rounded-md');
    const all = await client.callTool({ name: 'get_tokens', arguments: {} });
    expect(text(all)).toContain(
      '- destructive: oklch(0.577 0.245 27.325) (dark: oklch(0.704 0.191 22.216)) → bg-destructive',
    );
    const { tokens } = all.structuredContent as { tokens: unknown[] };
    expect(tokens).toHaveLength(31);
    const none = await client.callTool({ name: 'get_tokens', arguments: { category: 'shadow' } });
    expect(text(none)).toMatch(
      /^No tokens match shadow\. The design system has color \(\d+\), .*; call get_tokens without filters to see them\.$/,
    );
  });

  it('get_tokens says when the project has no tokens at all', async () => {
    const ds = await load(fixture({ 'package.json': '{ "name": "plain" }' }));
    const server = createServer({ getDesignSystem: () => Promise.resolve(ds) });
    const other = new Client({ name: 'empty', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), other.connect(clientTransport)]);
    const result = await other.callTool({ name: 'get_tokens', arguments: {} });
    expect(text(result)).toContain('No design tokens found in this project');
    expect(text(result)).toContain('Set "tokens" in the config');
    expect(text(result)).not.toContain('without filters');
    await other.close();
  });

  it('check_ui on code and on a project file', async () => {
    const result = await client.callTool({
      name: 'check_ui',
      arguments: { code: '<Button variant="danger">Delete</Button>' },
    });
    expect(text(result)).toContain(
      '1:17 error [no-unknown-variant] "danger" is not a valid variant',
    );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      errorCount: 1,
      file: 'snippet.tsx',
    });

    const file = await client.callTool({
      name: 'check_ui',
      arguments: { path: 'app/settings/danger-zone.tsx' },
    });
    expect(file.structuredContent).toMatchObject({
      file: 'app/settings/danger-zone.tsx',
      errorCount: 8,
      warningCount: 3,
    });

    const clean = await client.callTool({
      name: 'check_ui',
      arguments: { path: 'app/settings/members.tsx' },
    });
    expect(text(clean)).toBe('app/settings/members.tsx: no design-system problems found.');
    expect(clean.structuredContent).toMatchObject({ ok: true });
    expect(clean.structuredContent).not.toHaveProperty('notice');
  });

  it('check_ui returns at most `limit` diagnostics, errors first, with totals per rule', async () => {
    // A long file: 60 hardcoded colors (errors) and 30 off-scale paddings (warnings).
    const code = [
      '<>',
      ...Array.from({ length: 30 }, () => '<p className="p-[13px]" />'),
      ...Array.from({ length: 60 }, () => '<p className="text-[#737373]" />'),
      '</>',
    ].join('\n');
    const result = await client.callTool({ name: 'check_ui', arguments: { code } });
    const content = result.structuredContent as {
      diagnostics: { ruleId: string; severity: string }[];
      errorCount: number;
      warningCount: number;
      omitted: number;
      byRule: Record<string, { errors: number; warnings: number }>;
    };
    expect(content.diagnostics).toHaveLength(50);
    expect(content.diagnostics.every((d) => d.severity === 'error')).toBe(true);
    expect(content).toMatchObject({
      errorCount: 60,
      warningCount: 30,
      omitted: 40,
      byRule: {
        'no-hardcoded-color': { errors: 60, warnings: 0 },
        'no-hardcoded-spacing': { errors: 0, warnings: 30 },
      },
    });
    expect(text(result)).toContain(
      'Showing 50 of 90 (errors first). By rule: no-hardcoded-color 60, no-hardcoded-spacing 30.',
    );
    expect(text(result)).toContain('40 more not shown');
    expect(
      text(result)
        .split('\n')
        .filter((l) => / \[no-hardcoded/.test(l)),
    ).toHaveLength(50);
    const all = await client.callTool({ name: 'check_ui', arguments: { code, limit: 200 } });
    expect((all.structuredContent as { diagnostics: unknown[]; omitted: number }).omitted).toBe(0);
    expect(text(all)).not.toContain('more not shown');
  });

  it('check_ui does not check an Open Graph image or an email', async () => {
    const result = await client.callTool({
      name: 'check_ui',
      arguments: {
        code: 'import { ImageResponse } from "next/og"\nexport default () => new ImageResponse(<div style={{ background: "#0a0a0a", padding: 24 }} />)',
        filename: 'app/opengraph-image.tsx',
      },
    });
    expect(text(result)).toBe(
      'app/opengraph-image.tsx: not checked. It renders an image (next/og), where design tokens and classes do not apply.',
    );
    expect(result.structuredContent).toMatchObject({ ok: true, diagnostics: [], omitted: 0 });
  });

  it('check_ui says when there is no design system to check against', async () => {
    const ds = await load(fixture({ 'package.json': '{ "name": "plain" }' }));
    const server = createServer({ getDesignSystem: () => Promise.resolve(ds) });
    const plain = new Client({ name: 'plain-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), plain.connect(clientTransport)]);
    const result = await plain.callTool({
      name: 'check_ui',
      arguments: { code: '<p className="text-gray-500">Hi</p>' },
    });
    const notice =
      'No design system found (no components or color tokens): only the accessibility rule ran. See https://onsystem.vercel.app/docs/configuration';
    expect(text(result)).toBe(`snippet.tsx: no design-system problems found.\n\n${notice}`);
    expect(result.structuredContent).toMatchObject({ ok: true, notice });
    await plain.close();
  });

  it('check_ui refuses paths outside the project and missing input', async () => {
    const outside = await client.callTool({
      name: 'check_ui',
      arguments: { path: '../../package.json' },
    });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toContain('outside the project root');
    const empty = await client.callTool({ name: 'check_ui', arguments: {} });
    expect(empty.isError).toBe(true);
  });

  it('rejects oversized input before doing any work', async () => {
    for (const [name, args] of [
      ['check_ui', { code: 'x'.repeat(1_000_001) }],
      ['check_ui', { path: 'a/'.repeat(3000) }],
      ['get_component', { name: 'X'.repeat(257) }],
      ['search_components', { query: 'button '.repeat(200) }],
      ['get_tokens', { query: 'x'.repeat(1001) }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/Input validation error.*Too big/);
    }
  });

  it('serves component and token resources, with completion', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['ds://tokens', 'ds://components/Button']),
    );
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates[0]?.uriTemplate).toBe('ds://components/{name}');

    const component = await client.readResource({ uri: 'ds://components/Dialog' });
    expect(component.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
    expect((component.contents[0] as { text: string }).text).toContain('# Dialog');

    const tokens = await client.readResource({ uri: 'ds://tokens' });
    expect(JSON.parse((tokens.contents[0] as { text: string }).text)).toHaveLength(31);

    const completion = await client.complete({
      ref: { type: 'ref/resource', uri: 'ds://components/{name}' },
      argument: { name: 'name', value: 'Dia' },
    });
    expect(completion.completion.values).toContain('DialogContent');
  });

  it('provides the build-with-design-system prompt', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['build-with-design-system']);
    const prompt = await client.getPrompt({
      name: 'build-with-design-system',
      arguments: { task: 'a delete-account card' },
    });
    const message = prompt.messages[0]?.content;
    expect(message?.type).toBe('text');
    const body = message?.type === 'text' ? message.text : '';
    expect(body).toContain('a delete-account card');
    expect(body).toContain('Button (variant, size)');
    expect(body).toContain('20 color');
  });
});

describe('check_ui on project files', () => {
  it('refuses a path that leaves the root through a symlink', async () => {
    const outside = fixture({ 'secret.tsx': 'SECRET=1 <div className="bg-red-500" />' });
    const root = fixture({
      'onsystem.config.json': '{ "tokens": [] }',
      'app/page.tsx': 'export default () => <div />',
    });
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    fs.symlinkSync(path.join(outside, 'secret.tsx'), path.join(root, 'app/secret.tsx'));
    fs.symlinkSync(path.join(root, 'app/page.tsx'), path.join(root, 'app/alias.tsx'));
    const ds = await load(root);
    const server = createServer({ getDesignSystem: () => Promise.resolve(ds) });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      for (const target of ['linked/secret.tsx', 'app/secret.tsx']) {
        const result = await client.callTool({ name: 'check_ui', arguments: { path: target } });
        expect(result.isError).toBe(true);
        expect(text(result)).toBe(`${target} is outside the project root (${root}).`);
      }
      for (const target of ['app/page.tsx', 'app/alias.tsx']) {
        const result = await client.callTool({ name: 'check_ui', arguments: { path: target } });
        expect(result.structuredContent).toMatchObject({ file: target, ok: true });
      }
    } finally {
      await client.close();
    }
  });
});

describe('project root from MCP client roots', () => {
  it('uses the first file:// root when started without --root or a config', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-roots-'));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await serveStdio({
      cwd,
      cache: false,
      watch: false,
      logger: silentLogger,
      transport: serverTransport,
    });
    const client = new Client(
      { name: 'roots-client', version: '1.0.0' },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(DEMO_ROOT).href, name: 'demo' }],
    }));
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'list_components', arguments: {} });
    expect(text(result)).toContain('Button <button>');
    await client.close();
    await server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('takes a working directory that holds a project over the roots the client reports', async () => {
    const cwd = fixture({
      'package.json': '{ "name": "here" }',
      'components/ui/chip.tsx': 'export function Chip() { return <span /> }\n',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await serveStdio({
      cwd,
      cache: false,
      watch: false,
      logger: silentLogger,
      transport: serverTransport,
    });
    const client = new Client(
      { name: 'roots-client', version: '1.0.0' },
      { capabilities: { roots: {} } },
    );
    let asked = 0;
    client.setRequestHandler(ListRootsRequestSchema, () => {
      asked++;
      return { roots: [{ uri: pathToFileURL(DEMO_ROOT).href, name: 'demo' }] };
    });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'list_components', arguments: {} });
    expect(text(result)).toContain('Chip');
    expect(asked).toBe(0);
    await client.close();
    await server.close();
  });

  it('finds a config under its old name in the working directory, says so once, and is named onsystem', async () => {
    const cwd = fixture({
      'components/ui/chip.tsx': 'export function Chip() { return <span /> }\n',
      'design-system-mcp.config.json': '{ "components": ["components/ui/*.tsx"] }',
    });
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await serveStdio({
      cwd,
      cache: false,
      watch: false,
      logger,
      transport: serverTransport,
    });
    const client = new Client({ name: 'c', version: '1.0.0' });
    await client.connect(clientTransport);
    expect(client.getServerVersion()).toMatchObject({ name: 'onsystem', title: 'onsystem' });
    const result = await client.callTool({ name: 'list_components', arguments: {} });
    expect(text(result)).toContain('Chip');
    expect(warnings.filter((w) => w.includes('design-system-mcp'))).toEqual([
      expect.stringContaining("design-system-mcp.config.json is the config's name from before"),
    ]);
    await client.close();
    await server.close();
  });

  it('reports config errors through tool results', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-bad-'));
    fs.writeFileSync(path.join(cwd, 'onsystem.config.json'), '{"components": 1}');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await serveStdio({
      cwd,
      cache: false,
      watch: false,
      logger: silentLogger,
      transport: serverTransport,
    });
    const client = new Client({ name: 'c', version: '1.0.0' });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'list_components', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Invalid config');
    await client.close();
    await server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

/** A project with one component, `Chip`, whose `tone` is neutral or accent. */
function chipProject(name: string) {
  return fixture({
    'package.json': JSON.stringify({ name }),
    'components/ui/chip.tsx':
      'export function Chip(props: { tone?: "neutral" | "accent" }) { return <span /> }\n',
    'app/page.tsx': 'export default () => <Chip tone="loud" />;\n',
  });
}

/** A config written in code that leaves `ran.txt` next to itself when it is run. */
const MARKER_CONFIG = [
  "import fs from 'node:fs';",
  "fs.writeFileSync(new URL('./ran.txt', import.meta.url), 'ran');",
  'export default {};',
  '',
].join('\n');

/** Serves from a folder outside any project, as a client that starts servers in the home or a plugin folder does. */
async function serveOutside(transport: NonNullable<Parameters<typeof serveStdio>[0]['transport']>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-outside-'));
  const infos: string[] = [];
  const logger = { ...silentLogger, info: (message: string) => infos.push(message) };
  const server = await serveStdio({ cwd, cache: false, watch: false, logger, transport });
  return {
    cwd,
    infos,
    close: async () => {
      await server.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe('project from the absolute path a call names', () => {
  it('finds it when started outside any project by a client without roots', async () => {
    const project = chipProject('chips');
    const page = path.join(project, 'app/page.tsx');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const served = await serveOutside(serverTransport);
    // A 2025-era client that does not support roots.
    const client = new Client({ name: 'no-roots', version: '1.0.0' });
    await client.connect(clientTransport);

    const checked = await client.callTool({ name: 'check_ui', arguments: { path: page } });
    expect(checked.isError).toBeFalsy();
    expect(checked.structuredContent).toMatchObject({ file: 'app/page.tsx', errorCount: 1 });
    expect(text(checked)).toContain('"loud" is not a valid tone for <Chip>');

    // Unsaved code under an absolute filename: checked as that file of the project.
    const draft = await client.callTool({
      name: 'check_ui',
      arguments: { code: '<Chip tone="accent" />', filename: path.join(project, 'app/new.tsx') },
    });
    expect(draft.structuredContent).toMatchObject({
      ok: true,
      file: path.join(project, 'app/new.tsx'),
    });

    // Without a path: the one project found so far.
    const chip = await client.callTool({ name: 'get_component', arguments: { name: 'Chip' } });
    expect(chip.isError).toBeFalsy();
    expect(text(chip)).toContain('tone?: "neutral" | "accent"');

    // Loaded once, however many calls name it.
    expect(served.infos.filter((line) => line.startsWith(`using ${project},`))).toHaveLength(1);
    await client.close();
    await served.close();
  });

  it('says which argument to pass when nothing names the project', async () => {
    const first = chipProject('first');
    const second = fixture({
      'package.json': JSON.stringify({ name: 'second' }),
      'components/ui/tag.tsx': 'export function Tag() { return <span /> }\n',
    });
    const [clientTransport, serverTransport] = ModernInMemoryTransport.createLinkedPair();
    const served = await serveOutside(serverTransport);
    // A 2026-07-28 client: no roots to offer.
    const client = new ModernClient(
      { name: 'modern', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(clientTransport);

    const none = await client.callTool({ name: 'list_components', arguments: {} });
    expect(none.isError).toBe(true);
    expect(text(none)).toContain(`it was started in ${served.cwd}, which holds no project`);
    expect(text(none)).toContain('Pass `path`');
    const relative = await client.callTool({
      name: 'check_ui',
      arguments: { path: 'app/page.tsx' },
    });
    expect(relative.isError).toBe(true);
    expect(text(relative)).toContain('Pass `path`');
    // Listing resources is not an error: there are none yet.
    expect(
      (await client.listResources()).resources.filter((r) => r.uri.startsWith('ds://components/')),
    ).toEqual([]);

    const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-nowhere-'));
    const lost = await client.callTool({
      name: 'list_components',
      arguments: { path: path.join(nowhere, 'page.tsx') },
    });
    expect(lost.isError).toBe(true);
    expect(text(lost)).toContain(`No project at or above ${path.join(nowhere, 'page.tsx')}`);
    fs.rmSync(nowhere, { recursive: true, force: true });

    const chips = await client.callTool({
      name: 'list_components',
      arguments: { path: path.join(first, 'app/page.tsx') },
    });
    expect(text(chips)).toContain('Chip');
    const tags = await client.callTool({ name: 'list_components', arguments: { path: second } });
    expect(text(tags)).toContain('Tag');
    expect(text(tags)).not.toContain('Chip');

    // Two projects found: a call without a path has to say which.
    const which = await client.callTool({ name: 'get_component', arguments: { name: 'Chip' } });
    expect(which.isError).toBe(true);
    expect(text(which)).toContain(`files in 2 projects (${first}, ${second})`);
    await client.close();
    await served.close();
  });

  it('never runs a JavaScript config of a project found from a path, and reads a JSON one', async () => {
    const project = chipProject('chips');
    const config = path.join(project, 'onsystem.config.mjs');
    fs.writeFileSync(config, MARKER_CONFIG);
    const marker = path.join(project, 'ran.txt');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const served = await serveOutside(serverTransport);
    const client = new Client({ name: 'no-roots', version: '1.0.0' });
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'check_ui',
      arguments: { path: path.join(project, 'app/page.tsx') },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`${config} was not run`);
    expect(text(result)).toContain('or use onsystem.config.json');
    expect(fs.existsSync(marker)).toBe(false);

    // A JSON config is read: it turns the rule off.
    const json = chipProject('json');
    fs.writeFileSync(
      path.join(json, 'onsystem.config.json'),
      JSON.stringify({ rules: { 'no-unknown-variant': 'off' } }),
    );
    const checked = await client.callTool({
      name: 'check_ui',
      arguments: { path: path.join(json, 'app/page.tsx') },
    });
    expect(checked.structuredContent).toMatchObject({ ok: true, errorCount: 0 });
    await client.close();
    await served.close();

    // Started in the project (--root), the server runs it as before.
    const [rootClientTransport, rootServerTransport] = InMemoryTransport.createLinkedPair();
    const server = await serveStdio({
      cwd: fixture({}),
      root: project,
      cache: false,
      watch: false,
      logger: silentLogger,
      transport: rootServerTransport,
    });
    const rootClient = new Client({ name: 'c', version: '1.0.0' });
    await rootClient.connect(rootClientTransport);
    const listed = await rootClient.callTool({ name: 'list_components', arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(text(listed)).toContain('Chip');
    expect(fs.existsSync(marker)).toBe(true);
    await rootClient.close();
    await server.close();
  });

  it('checks code under an absolute filename as that file, overrides included', async () => {
    const project = chipProject('chips');
    fs.writeFileSync(
      path.join(project, 'onsystem.config.json'),
      JSON.stringify({
        overrides: [{ files: 'app/legacy/**', rules: { 'no-unknown-variant': 'off' } }],
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await serveStdio({
      cwd: project,
      cache: false,
      watch: false,
      logger: silentLogger,
      transport: serverTransport,
    });
    const client = new Client({ name: 'c', version: '1.0.0' });
    await client.connect(clientTransport);
    const code = '<Chip tone="loud" />';
    const legacy = path.join(project, 'app/legacy/old.tsx');
    const result = await client.callTool({
      name: 'check_ui',
      arguments: { code, filename: legacy },
    });
    expect(result.structuredContent).toMatchObject({ ok: true, errorCount: 0, file: legacy });
    const current = path.join(project, 'app/new.tsx');
    const checked = await client.callTool({
      name: 'check_ui',
      arguments: { code, filename: current },
    });
    expect(checked.structuredContent).toMatchObject({ errorCount: 1, file: current });
    await client.close();
    await server.close();
  });

  it('keeps serving the working directory that --components describes', async () => {
    // No package.json: only the flag says this folder is the project.
    const cwd = fixture({ 'ui/chip.tsx': 'export function Chip() { return <span /> }\n' });
    const [clientTransport, serverTransport] = ModernInMemoryTransport.createLinkedPair();
    const server = await serveStdio({
      cwd,
      components: ['ui/*.tsx'],
      cache: false,
      watch: false,
      logger: silentLogger,
      transport: serverTransport,
    });
    const client = new ModernClient(
      { name: 'modern', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'list_components', arguments: {} });
    expect(text(result)).toContain('Chip');
    await client.close();
    await server.close();
  });

  it('falls back to the paths when a client with roots reports no file:// root', async () => {
    const project = chipProject('chips');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const served = await serveOutside(serverTransport);
    const client = new Client(
      { name: 'roots-client', version: '1.0.0' },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [] }));
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'get_component',
      arguments: { name: 'Chip', path: path.join(project, 'app/page.tsx') },
    });
    expect(text(result)).toContain('tone?: "neutral" | "accent"');
    await client.close();
    await served.close();
  });
});

describe('change notifications', () => {
  it('logs, rather than throws, when the client cannot be notified', async () => {
    const root = fixture({
      'components/ui/chip.tsx': 'export function Chip() { return <span /> }\n',
    });
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, options) =>
      'method' in message && message.method === 'notifications/resources/list_changed'
        ? Promise.reject(new Error('client went away'))
        : send(message, options);
    const server = await serveStdio({
      cwd: root,
      root,
      cache: false,
      watch: true,
      logger,
      transport: serverTransport,
    });
    const client = new Client({ name: 'c', version: '1.0.0' });
    await client.connect(clientTransport);
    await client.callTool({ name: 'list_components', arguments: {} });
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(
      path.join(root, 'components/ui/badge.tsx'),
      'export function Badge() { return <span /> }\n',
    );
    await vi.waitFor(
      () => {
        expect(warnings.join('\n')).toContain('client went away');
      },
      { timeout: 10_000 },
    );
    await client.close();
    await server.close();
  }, 15_000);
});
