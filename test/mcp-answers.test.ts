import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DesignSystem } from '../src/design-system.js';
import { createServer, INSTRUCTIONS } from '../src/server/index.js';
import { WorkspaceProjects } from '../src/server/projects.js';
import { silentLogger } from '../src/util/log.js';
import { loadTarget } from '../src/workspace.js';
import { DEMO_ROOT, fixture, load, loadOnce, TSCONFIG } from './helpers.js';

// What the MCP tools answer when the design system is thin or large: a stock shadcn/ui app
// (no JSDoc, no docs), a query the design system has no component for, a design system that
// is mostly icons, and a theme whose only greens are chart colors.

function text(result: unknown): string {
  const content = (result as CallToolResult).content[0];
  return content?.type === 'text' ? content.text : '';
}

const clients: Client[] = [];
afterAll(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function connect(options: Parameters<typeof createServer>[0]): Promise<Client> {
  const server = createServer(options);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

const serve = (ds: DesignSystem) => connect({ getDesignSystem: () => Promise.resolve(ds) });

type Results = { results: { name: string; weak?: boolean }[] };

const stockTheme = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures/shadcn-neutral/globals.css'),
  'utf8',
);

/**
 * A stock shadcn/ui app (new-york-v4, Radix): the files `npx shadcn add` writes, with their
 * class strings shortened. They have no JSDoc, and there are no docs.
 */
const STOCK_SHADCN = {
  'package.json': JSON.stringify({ name: 'stock-app' }),
  'tsconfig.json': TSCONFIG,
  'components.json': JSON.stringify({
    style: 'new-york',
    tsx: true,
    tailwind: { css: 'app/globals.css', baseColor: 'neutral', cssVariables: true },
    aliases: { components: '@/components', utils: '@/lib/utils', ui: '@/components/ui' },
  }),
  'app/globals.css': stockTheme,
  'lib/utils.ts':
    'import { clsx, type ClassValue } from "clsx"\nimport { twMerge } from "tailwind-merge"\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs))\n}\n',
  'components/ui/avatar.tsx': `"use client"

import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "@/lib/utils"

function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return <AvatarPrimitive.Root data-slot="avatar" className={cn("relative flex size-8 shrink-0 overflow-hidden rounded-full", className)} {...props} />
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return <AvatarPrimitive.Image data-slot="avatar-image" className={cn("aspect-square size-full", className)} {...props} />
}

function AvatarFallback({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return <AvatarPrimitive.Fallback data-slot="avatar-fallback" className={cn("bg-muted flex size-full items-center justify-center rounded-full", className)} {...props} />
}

export { Avatar, AvatarImage, AvatarFallback }
`,
  'components/ui/badge.tsx': `import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-white",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
`,
  'components/ui/button.tsx': `import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline: "border bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md gap-1.5 px-3",
        lg: "h-10 rounded-md px-6",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
`,
  'components/ui/card.tsx': `import * as React from "react"

import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card" className={cn("bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm", className)} {...props} />
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("grid auto-rows-min items-start gap-1.5 px-6", className)} {...props} />
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-title" className={cn("leading-none font-semibold", className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-muted-foreground text-sm", className)} {...props} />
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-action" className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)} {...props} />
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex items-center px-6", className)} {...props} />
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent }
`,
  'components/ui/label.tsx': `"use client"

import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"

import { cn } from "@/lib/utils"

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root data-slot="label" className={cn("flex items-center gap-2 text-sm leading-none font-medium select-none", className)} {...props} />
}

export { Label }
`,
  'components/ui/select.tsx': `"use client"

import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger data-slot="select-trigger" data-size={size} className={cn("border-input flex w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm", className)} {...props}>
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({ className, children, position = "popper", ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content data-slot="select-content" className={cn("bg-popover text-popover-foreground relative z-50 rounded-md border shadow-md", className)} position={position} {...props}>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label data-slot="select-label" className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)} {...props} />
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm", className)} {...props}>
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator data-slot="select-separator" className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)} {...props} />
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue }
`,
};

describe('search_components when nothing clearly matches (the demo)', () => {
  let client: Client;
  beforeAll(async () => {
    client = await serve(await loadOnce(DEMO_ROOT));
  });

  const search = async (query: string, limit = 5) => {
    const result = await client.callTool({
      name: 'search_components',
      arguments: { query, limit },
    });
    return { text: text(result), ...(result.structuredContent as Results) };
  };

  it.each([
    // The demo has no select, combobox, table or tooltip: each comes back with one word in common.
    ['a dropdown menu to pick a country', 'CardAction'],
    ['data table with sorting', 'Button'],
    ['show a tooltip on hover', 'Button'],
  ])('"%s" says no component clearly matches; the nearest is %s', async (query, nearest) => {
    const found = await search(query);
    expect(found.text).toMatch(
      new RegExp(
        `^No component clearly matches "${query}"\\. The nearest have only a word or two in common with it:\\n\\n1\\. ${nearest}`,
      ),
    );
    expect(found.text).toContain('the design system may have no component for this: ask');
    expect(found.text).not.toContain('best first');
    expect(found.results[0]).toMatchObject({ name: nearest, weak: true });
    expect(found.results.every((r) => r.weak)).toBe(true);
  });

  it('keeps clear matches, best first, and leaves out the ones with a word in common', async () => {
    const modal = await search('modal window');
    expect(modal.text).toMatch(/^Components for "modal window", best first:\n\n1\. Dialog —/);
    expect(modal.results.map((r) => r.name)).toEqual(['Dialog']);
    expect(modal.results[0]).not.toHaveProperty('weak');

    const panel = await search('group settings in a panel');
    expect(panel.results.map((r) => r.name)).toEqual(['Card']);

    const destructive = await search('confirm a destructive action', 3);
    expect(destructive.results.map((r) => r.name).slice(0, 2)).toEqual(['Dialog', 'Button']);
    expect(destructive.results.some((r) => r.weak)).toBe(false);
  });

  it('counts a word that names the component as a clear match', async () => {
    const found = await search('primary button');
    expect(found.results[0]).toEqual(expect.objectContaining({ name: 'Button' }));
    expect(found.results[0]).not.toHaveProperty('weak');
  });
});

describe('a stock shadcn/ui app, whose files have no JSDoc', () => {
  let client: Client;
  beforeAll(async () => {
    client = await serve(await load(fixture(STOCK_SHADCN, { nodeModules: true })));
  });

  it('lists what each component is for, as shadcn/ui\'s, and never "No description."', async () => {
    const list = text(await client.callTool({ name: 'list_components', arguments: {} }));
    expect(list).not.toContain('No description.');
    expect(list).toContain(
      "Badge <span> — shadcn/ui's Badge: A small label for a status, a count or a category.",
    );
    expect(list).toContain(
      "Select — shadcn/ui's Select: Lets the user pick one value from a list that opens from a button.",
    );
    const result = await client.callTool({ name: 'list_components', arguments: {} });
    const { components } = result.structuredContent as {
      components: { name: string; description?: string; variants?: object }[];
    };
    expect(components.find((c) => c.name === 'Label')).toEqual({
      name: 'Label',
      description: "shadcn/ui's Label: The text label of a form control.",
      importPath: '@/components/ui/label',
    });
  });

  it('finds Badge first for "status label"', async () => {
    const result = await client.callTool({
      name: 'search_components',
      arguments: { query: 'status label' },
    });
    const { results } = result.structuredContent as Results;
    expect(results[0]?.name).toBe('Badge');
    expect(results.some((r) => r.weak)).toBe(false);
  });

  it('says that nothing matches "date picker calendar" rather than offering Select parts', async () => {
    const result = await client.callTool({
      name: 'search_components',
      arguments: { query: 'date picker calendar' },
    });
    expect(text(result)).toMatch(/^No component clearly matches "date picker calendar"/);
    expect((result.structuredContent as Results).results.every((r) => r.weak)).toBe(true);
  });

  it('says that a dotted name is not how the design system writes the part', async () => {
    const result = await client.callTool({
      name: 'get_component',
      arguments: { name: 'Card.Header' },
    });
    expect(text(result)).toMatch(
      /^There is no `Card\.Header` in this design system: write `<CardHeader>`\.\n\n# CardHeader\n/,
    );
    const plain = await client.callTool({
      name: 'get_component',
      arguments: { name: 'CardHeader' },
    });
    expect(text(plain)).toMatch(/^# CardHeader\n/);
  });

  it('shows the parts before the props', async () => {
    const card = text(
      await client.callTool({ name: 'get_component', arguments: { name: 'Card' } }),
    );
    expect(card).toMatch(
      /^# Card\nshadcn\/ui's Card: A bordered surface that groups related content, with a header, content and footer\.\n/,
    );
    expect(card.indexOf('## Parts')).toBeGreaterThan(0);
    expect(card.indexOf('## Parts')).toBeLessThan(card.indexOf('## Props'));
  });

  it('does not tell the agent to follow examples a component does not have', async () => {
    const prompt = await client.getPrompt({
      name: 'build-with-design-system',
      arguments: { task: 'a settings card' },
    });
    const content = prompt.messages[0]?.content;
    const body = content?.type === 'text' ? content.text : '';
    expect(body).not.toContain('compose parts the way its examples do');
    expect(body).toContain('compose its parts as its docs and examples show, when it has them');
  });
});

describe('get_tokens: chart and sidebar colors', () => {
  let client: Client;
  beforeAll(async () => {
    client = await serve(await load(fixture(STOCK_SHADCN, { nodeModules: true })));
  });

  it('lists them under their own headings, after the colors, as not for status colors', async () => {
    const tokens = text(await client.callTool({ name: 'get_tokens', arguments: {} }));
    const chart = tokens.indexOf('## chart (5): for charts only, not for status colors');
    const sidebar = tokens.indexOf('## sidebar (8): for the sidebar only, not for status colors');
    const colors = tokens.indexOf('## color (');
    expect(colors).toBeGreaterThanOrEqual(0);
    expect(chart).toBeGreaterThan(colors);
    expect(sidebar).toBeGreaterThan(colors);
    // chart-2 is listed under its heading, not among the colors to pick from.
    const chart2 = tokens.indexOf('- chart-2: ');
    expect(chart2).toBeGreaterThan(chart);
    const colorSection = tokens.slice(colors, Math.min(chart, sidebar));
    expect(colorSection).not.toMatch(/- (?:chart|sidebar)/);
    expect(colorSection).toContain('- destructive: ');

    const only = text(
      await client.callTool({ name: 'get_tokens', arguments: { query: 'chart-2' } }),
    );
    expect(only).toMatch(/^## chart \(1\): for charts only, not for status colors\n- chart-2: /);
  });

  it('tells the agent not to use them for a status color the theme has no token for', async () => {
    const clause =
      'for a status color the theme has no token for (success, warning, info), add a token or keep the Tailwind color as check_ui says, and never use a chart-* or sidebar-* token for it.';
    expect(INSTRUCTIONS).toContain(clause);
    // The prompt gives the same way out: without it, nothing is left for a green label but gray.
    const prompt = await client.getPrompt({
      name: 'build-with-design-system',
      arguments: { task: 'a plan card with a green Active label' },
    });
    const content = prompt.messages[0]?.content;
    expect(content?.type === 'text' ? content.text : '').toContain(clause);
  });
});

describe('get_component: long prop docs', () => {
  it('cuts a long description to its first sentence and keeps a short one whole', async () => {
    const ds = await load(
      fixture({
        'package.json': JSON.stringify({ name: 'picker' }),
        'onsystem.config.json': JSON.stringify({ components: ['components/**/*.tsx'], tokens: [] }),
        'components/picker.tsx': `export interface PickerProps {
  /**
   * A ref to imperative actions. When it is set, the popup is not unmounted when closed:
   * call its \`unmount\` function to unmount it. Useful when an animation library controls
   * the popup's exit.
   */
  actionsRef?: { current: unknown }
  /** Visual style. Use \`subtle\` inside cards. */
  tone?: "default" | "subtle"
}

export function Picker(props: PickerProps) {
  return <div />
}
`,
      }),
    );
    const client = await serve(ds);
    const result = await client.callTool({ name: 'get_component', arguments: { name: 'Picker' } });
    expect(text(result)).toContain(
      '- actionsRef?: { current: unknown; } — "A ref to imperative actions."\n',
    );
    expect(text(result)).not.toContain('Useful when');
    expect(text(result)).toContain('— "Visual style. Use `subtle` inside cards."');
    const { props } = result.structuredContent as {
      props: { name: string; description: string }[];
    };
    expect(props.find((p) => p.name === 'actionsRef')?.description).toContain('Useful when');
  });
});

/** Six icons and a button, as a design system with its own icon set has them. */
const ICONS = Object.fromEntries(
  ['Check', 'ChevronDown', 'Close', 'Plus', 'Search', 'Spinner'].map((name) => [
    name,
    `export function ${name}Icon(props: React.SVGProps<SVGSVGElement>) {\n  return <svg viewBox="0 0 24 24" {...props}><path d="M0 0h24v24H0z" /></svg>\n}\n`,
  ]),
);
const ICON_FILE = `import * as React from "react"\n\n${Object.values(ICONS).join('\n')}`;
const ICON_NAMES = Object.keys(ICONS).map((name) => `${name}Icon`);

describe('list_components on a design system with an icon set', () => {
  let client: Client;
  beforeAll(async () => {
    const ds = await load(
      fixture(
        {
          'package.json': JSON.stringify({ name: 'iconic' }),
          'tsconfig.json': TSCONFIG,
          'onsystem.config.json': JSON.stringify({
            components: ['components/**/*.tsx'],
            tokens: [],
          }),
          'components/icons.tsx': ICON_FILE,
          'components/ui/badge.tsx':
            'export function Badge(props: { children?: React.ReactNode }) { return <span /> }\n',
          'components/ui/button.tsx': STOCK_SHADCN['components/ui/button.tsx'],
          'lib/utils.ts': STOCK_SHADCN['lib/utils.ts'],
        },
        { nodeModules: true },
      ),
    );
    client = await serve(ds);
  });

  const list = async (args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: 'list_components', arguments: args });
    return {
      text: text(result),
      content: result.structuredContent as {
        components: { name: string; variants?: object; subcomponents?: string[] }[];
        icons?: { from: string; names: string[] }[];
        omitted?: number;
      },
    };
  };

  it('names the icons on one line per import, after the other components', async () => {
    const { text: body, content } = await list();
    expect(body).toMatch(/^8 components\. Call get_component before using one\.\n/);
    expect(body).toContain(
      `6 icons from "@/components/icons" (each renders <svg>; import { Name } from "@/components/icons"): ${ICON_NAMES.join(', ')}`,
    );
    expect(body).not.toContain('CheckIcon <svg>');
    expect(body).toContain('Pass kind "icon" to list the icons one by one.');
    expect(content.components.map((c) => c.name)).toEqual(['Badge', 'Button']);
    expect(content.icons).toEqual([{ from: '@/components/icons', names: ICON_NAMES }]);
    // Empty arrays are left out.
    expect(content.components[0]).not.toHaveProperty('variants');
    expect(content.components[0]).not.toHaveProperty('subcomponents');
    expect(content.components[1]).toHaveProperty('variants');
  });

  it('lists only the icons, one by one, with kind "icon", and none with kind "component"', async () => {
    const icons = await list({ kind: 'icon' });
    expect(icons.text).toMatch(/^6 of 8 components match kind "icon"\./);
    expect(icons.text).toContain(
      'CheckIcon <svg>\n  import { CheckIcon } from "@/components/icons"',
    );
    expect(icons.content.components.map((c) => c.name)).toEqual(ICON_NAMES);
    expect(icons.content).not.toHaveProperty('icons');

    const components = await list({ kind: 'component' });
    expect(components.content.components.map((c) => c.name)).toEqual(['Badge', 'Button']);
    expect(components.text).not.toContain('icons from');
    expect(components.text).not.toContain('Pass kind "icon"');
  });

  it('filters by query and stops at limit, saying how many it left out', async () => {
    const chevron = await list({ query: 'chevron' });
    expect(chevron.text).toMatch(/^1 of 8 components match query "chevron"\./);
    expect(chevron.content.components.map((c) => c.name)).toEqual(['ChevronDownIcon']);

    const first = await list({ kind: 'icon', limit: 2 });
    expect(first.content.components.map((c) => c.name)).toEqual(['CheckIcon', 'ChevronDownIcon']);
    expect(first.content.omitted).toBe(4);
    expect(first.text).toContain('4 more not shown: pass a higher `limit`, or a `query`.');

    const none = await list({ query: 'carousel' });
    expect(none.text).toBe(
      'No components match query "carousel" (8 in all). Call list_components without filters to see them.',
    );
  });
});

describe('list_components at a monorepo root with an icon set', () => {
  it("names a package's icons on one line in its section", async () => {
    const json = (value: unknown) => JSON.stringify(value, null, 2);
    const root = fixture({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
      'package.json': json({ name: 'acme', private: true }),
      'packages/ui/package.json': json({
        name: '@acme/ui',
        exports: {
          './button': './src/button.tsx',
          './card': './src/card.tsx',
          './icons': './src/icons.tsx',
        },
      }),
      'packages/ui/src/button.tsx':
        'export function Button(props: { children?: unknown }) { return <button /> }\n',
      'packages/ui/src/card.tsx':
        'export function Card(props: { children?: unknown }) { return <div /> }\n',
      'packages/ui/src/icons.tsx': ICON_FILE,
      'apps/web/package.json': json({
        name: '@acme/web',
        dependencies: { '@acme/ui': 'workspace:*' },
      }),
      'apps/web/app/page.tsx':
        'import { Button } from "@acme/ui/button";\nexport default () => <Button>Go</Button>;\n',
    });
    const { workspace } = await loadTarget({ cwd: root });
    if (!workspace) throw new Error('expected a workspace');
    const projects = new WorkspaceProjects(workspace, {
      cache: false,
      watch: false,
      logger: silentLogger,
    });
    try {
      const client = await connect({
        getDesignSystem: () => Promise.reject(new Error('not used')),
        getProjects: () => Promise.resolve(projects),
      });
      const result = await client.callTool({ name: 'list_components', arguments: {} });
      expect(text(result)).toMatch(
        /^8 components from 1 package, used by 2 projects\..*\n\n## @acme\/ui \(used by apps\/web and packages\/ui\)\nButton <button>\n/,
      );
      expect(text(result)).toContain(
        `  import { Card } from "@acme/ui/card"\n\n6 icons from "@acme/ui/icons" (each renders <svg>; import { Name } from "@acme/ui/icons"): ${ICON_NAMES.join(', ')}`,
      );
      expect(result.structuredContent).toMatchObject({
        icons: [{ from: '@acme/ui/icons', names: ICON_NAMES, package: '@acme/ui' }],
      });
    } finally {
      projects.close();
    }
  });
});

describe('list_components on an icon set with a module per icon', () => {
  it('names the icons on one line per folder, each with its module', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'iconic-files' }),
      'tsconfig.json': TSCONFIG,
      'onsystem.config.json': JSON.stringify({ components: ['components/**/*.tsx'], tokens: [] }),
      'components/ui/button.tsx': STOCK_SHADCN['components/ui/button.tsx'],
      'lib/utils.ts': STOCK_SHADCN['lib/utils.ts'],
      // One icon elsewhere is listed like any component.
      'components/logo.tsx':
        'export function Logo() {\n  return <svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" /></svg>\n}\n',
    };
    const modules = ['check', 'chevron-down', 'close', 'plus', 'search', 'spinner'];
    modules.forEach((module, i) => {
      files[`components/icons/${module}.tsx`] = `import * as React from "react"\n\n${
        Object.values(ICONS)[i] ?? ''
      }`;
    });
    const client = await serve(await load(fixture(files, { nodeModules: true })));
    const result = await client.callTool({ name: 'list_components', arguments: {} });
    const named = ICON_NAMES.map((name, i) => `${name} (${modules[i] ?? ''})`).join(', ');
    expect(text(result)).toContain(
      `6 icons in "@/components/icons" (each renders <svg>; import { Name } from "@/components/icons/<module>"): ${named}`,
    );
    expect(text(result)).toContain('Logo <svg>\n  import { Logo } from "@/components/logo"');
    expect(text(result)).not.toContain('CheckIcon <svg>');
    const content = result.structuredContent as {
      components: { name: string }[];
      icons?: { from: string; names: string[]; modules?: string[] }[];
    };
    expect(content.components.map((c) => c.name).sort()).toEqual(['Button', 'Logo']);
    expect(content.icons).toEqual([
      {
        from: '@/components/icons',
        names: ICON_NAMES,
        modules: modules.map((m) => `@/components/icons/${m}`),
      },
    ]);
  });
});

describe('check_ui with code and path', () => {
  let client: Client;
  beforeAll(async () => {
    const root = fixture(
      {
        'package.json': JSON.stringify({ name: 'legacy' }),
        'tsconfig.json': TSCONFIG,
        'onsystem.config.json': JSON.stringify({
          components: ['components/ui/**/*.tsx'],
          tokens: ['app/globals.css'],
          overrides: [{ files: 'app/legacy/**', rules: { 'no-hardcoded-color': 'off' } }],
        }),
        'app/globals.css': stockTheme,
        'app/legacy/old.tsx': 'export const Old = () => <p className="text-[#e11d48]">Old</p>;\n',
        'components/ui/button.tsx': STOCK_SHADCN['components/ui/button.tsx'],
        'lib/utils.ts': STOCK_SHADCN['lib/utils.ts'],
      },
      { nodeModules: true },
    );
    client = await serve(await load(root));
  });
  const code = '<p className="text-[#e11d48]">Overdue</p>';

  it('checks the code as the file `path` names, as it does with `filename`', async () => {
    const legacy = await client.callTool({
      name: 'check_ui',
      arguments: { code, path: 'app/legacy/new.tsx' },
    });
    expect(legacy.structuredContent).toMatchObject({
      file: 'app/legacy/new.tsx',
      errorCount: 0,
      warningCount: 0,
    });
    const current = await client.callTool({
      name: 'check_ui',
      arguments: { code, path: 'app/new.tsx' },
    });
    expect(current.structuredContent).toMatchObject({ file: 'app/new.tsx', ok: false });
    expect(text(current)).toMatch(/^app\/new\.tsx: 1 error/);
    // `filename` still wins, and the path is still what is read without code.
    const named = await client.callTool({
      name: 'check_ui',
      arguments: { code, path: 'app/legacy/new.tsx', filename: 'app/other.tsx' },
    });
    expect(named.structuredContent).toMatchObject({ file: 'app/other.tsx', ok: false });
  });

  it.each(['.', 'app', 'app/legacy', 'app/globals.css'])(
    'checks the code as snippet.tsx when `path` is %s, which names no .tsx file',
    async (folder) => {
      const result = await client.callTool({
        name: 'check_ui',
        arguments: { code, path: folder },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        file: 'snippet.tsx',
        ok: false,
        errorCount: 1,
      });
    },
  );

  it('says what to pass when `filename` is not a script file', async () => {
    const css = await client.callTool({
      name: 'check_ui',
      arguments: { code, filename: 'app/globals.css' },
    });
    expect(css.isError).toBe(true);
    expect(text(css)).toBe(
      'check_ui checks .tsx, .jsx, .ts and .js files; app/globals.css is not one, so it was not checked. Pass as `filename` the .tsx path the code is for, or leave `filename` out.',
    );
    // Without code, `path` is the file to check, and a stylesheet is still not one.
    const file = await client.callTool({
      name: 'check_ui',
      arguments: { path: 'app/globals.css' },
    });
    expect(text(file)).toBe(
      'check_ui checks .tsx, .jsx, .ts and .js files; app/globals.css is not one, so it was not checked.',
    );
  });
});

describe('check_ui with code and a folder at a monorepo root', () => {
  it("checks the code with the folder's project, as snippet.tsx", async () => {
    const json = (value: unknown) => JSON.stringify(value, null, 2);
    const root = fixture({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
      'package.json': json({ name: 'acme', private: true }),
      'packages/ui/package.json': json({
        name: '@acme/ui',
        exports: {
          './button': './src/button.tsx',
          './card': './src/card.tsx',
          './input': './src/input.tsx',
        },
      }),
      'packages/ui/src/button.tsx':
        'export function Button(props: { variant?: "default" | "outline"; children?: unknown }) { return <button /> }\n',
      'packages/ui/src/card.tsx':
        'export function Card(props: { children?: unknown }) { return <div /> }\n',
      'packages/ui/src/input.tsx':
        'export function Input(props: { value?: string }) { return <input /> }\n',
      'apps/web/package.json': json({
        name: '@acme/web',
        dependencies: { '@acme/ui': 'workspace:*' },
      }),
      'apps/web/app/page.tsx':
        'import { Button } from "@acme/ui/button";\nexport default () => <Button>Go</Button>;\n',
      'apps/admin/package.json': json({ name: '@acme/admin' }),
      'apps/admin/components.json': json({ aliases: { ui: '@/components/ui' } }),
      'apps/admin/tsconfig.json': json({
        compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./*'] } },
      }),
      'apps/admin/components/ui/button.tsx':
        'export function Button(props: { variant?: "default" | "ghost"; children?: unknown }) { return <button /> }\n',
    });
    const { workspace } = await loadTarget({ cwd: root });
    if (!workspace) throw new Error('expected a workspace');
    const projects = new WorkspaceProjects(workspace, {
      cache: false,
      watch: false,
      logger: silentLogger,
    });
    try {
      const client = await connect({
        getDesignSystem: () => Promise.reject(new Error('not used')),
        getProjects: () => Promise.resolve(projects),
      });
      const check = (args: Record<string, unknown>) =>
        client.callTool({ name: 'check_ui', arguments: args });

      const web = await check({
        code: 'import { Button } from "@acme/ui/button";\nexport const A = () => <Button variant="danger" />;\n',
        path: 'apps/web',
      });
      expect(web.structuredContent).toMatchObject({ file: 'snippet.tsx', errorCount: 1 });
      expect(text(web)).toContain('Allowed: default, outline.');

      const admin = await check({
        code: 'import { Button } from "@/components/ui/button";\nexport const A = () => <Button variant="danger" />;\n',
        path: 'apps/admin/app',
      });
      expect(admin.structuredContent).toMatchObject({ file: 'snippet.tsx', errorCount: 1 });
      expect(text(admin)).toContain('Allowed: default, ghost.');

      // The root itself picks no project: it asks for the file, as without a path.
      const atRoot = await check({ code: '<p>x</p>', path: '.' });
      expect(atRoot.isError).toBe(true);
      expect(text(atRoot)).toMatch(/^This is a monorepo root with \d projects .*Pass `filename`/);
    } finally {
      projects.close();
    }
  });
});

describe('shadcn/ui descriptions in a design system that is not shadcn/ui', () => {
  let client: Client;
  beforeAll(async () => {
    const ds = await load(
      fixture({
        'package.json': JSON.stringify({ name: 'grid-kit' }),
        'tsconfig.json': TSCONFIG,
        'onsystem.config.json': JSON.stringify({ components: ['src/**/*.tsx'], tokens: [] }),
        // Same names as shadcn/ui's, different components: a data grid and a code span.
        'src/sheet.tsx':
          'export function Sheet(props: { rows: string[][] }) {\n  return <table>{props.rows.map((r) => <tr key={r[0]}>{r.map((c) => <td key={c}>{c}</td>)}</tr>)}</table>\n}\n',
        'src/command.tsx':
          'export function Command(props: { children?: React.ReactNode }) {\n  return <code>{props.children}</code>\n}\n',
      }),
    );
    client = await serve(ds);
  });

  it('borrows no description for a same-named component outside a ui folder', async () => {
    const result = await client.callTool({ name: 'list_components', arguments: {} });
    expect(text(result)).toContain('Command <code>\n');
    expect(text(result)).toContain('Sheet <table>\n');
    expect(text(result)).not.toContain('shadcn/ui');
    const { components } = result.structuredContent as {
      components: { name: string; description?: string }[];
    };
    expect(components.every((c) => c.description === undefined)).toBe(true);

    const sheet = text(
      await client.callTool({ name: 'get_component', arguments: { name: 'Sheet' } }),
    );
    expect(sheet).toMatch(/^# Sheet\n\nimport \{ Sheet \}/);

    const search = await client.callTool({
      name: 'search_components',
      arguments: { query: 'slide-in panel' },
    });
    const { results } = search.structuredContent as Results;
    expect(results.filter((r) => !r.weak).map((r) => r.name)).not.toContain('Sheet');
  });
});
