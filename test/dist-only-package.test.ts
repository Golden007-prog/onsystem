import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { fixture, TSCONFIG } from './helpers.js';

// An app that installs a design-system package published as compiled `dist/` alone, without type
// declarations, whose config sets `importPath`, as `init` writes it for a package apps import by
// one name. The app's model has no components, so `check` says the component rules did not run;
// they must not then report every component the app imports from the package as one the design
// system does not have. With type declarations, its components are read from them.

const json = (value: unknown) => JSON.stringify(value, null, 2);

const THEME =
  '@theme {\n  --spacing: 0.25rem;\n  --color-primary: oklch(0.55 0.2 260);\n  --radius-md: 0.375rem;\n}\n';

/**
 * `@acme/ui` as npm publishes it: `dist/`, the tokens and `init`'s config, but no `src/`, and no
 * type declarations.
 */
const DIST_ONLY = {
  'package.json': json({
    name: '@acme/ui',
    version: '1.0.0',
    files: ['dist', 'theme.css', 'onsystem.config.json'],
    main: './dist/index.js',
    exports: {
      '.': { import: './dist/index.js' },
      './theme.css': './theme.css',
    },
    onsystem: './onsystem.config.json',
  }),
  'onsystem.config.json': json({
    components: ['src/button.tsx', 'src/card.tsx', 'src/input.tsx'],
    importPath: '@acme/ui',
    tokens: ['theme.css'],
  }),
  'theme.css': THEME,
  'dist/index.js':
    'export function Button() {}\nexport function Card() {}\nexport function Input() {}\nexport function ChevronLeft() {}\n',
};

/** The same package with the type declarations tsc emits for it, named in its package.json. */
const WITH_DECLARATIONS = {
  ...DIST_ONLY,
  'package.json': json({
    ...(JSON.parse(DIST_ONLY['package.json']) as Record<string, unknown>),
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './theme.css': './theme.css',
    },
  }),
  'dist/index.d.ts': [
    "import * as react from 'react';",
    "import * as react_jsx_runtime from 'react/jsx-runtime';",
    'declare function Button(props: react.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" }): react_jsx_runtime.JSX.Element;',
    'declare function Card(props: react.HTMLAttributes<HTMLDivElement>): react_jsx_runtime.JSX.Element;',
    'declare function Input(props: react.InputHTMLAttributes<HTMLInputElement>): react_jsx_runtime.JSX.Element;',
    'declare function ChevronLeft(props: react.SVGProps<SVGSVGElement>): react_jsx_runtime.JSX.Element;',
    'export { Button, Card, ChevronLeft, Input };',
    '',
  ].join('\n'),
};

/** The same package published with its component sources. */
const WITH_SOURCES = {
  ...DIST_ONLY,
  'src/index.tsx': 'export * from "./button";\nexport * from "./card";\nexport * from "./input";\n',
  'src/button.tsx':
    'export function Button(props: { variant?: "default" | "outline"; children?: unknown }) { return <button /> }\n',
  'src/card.tsx': 'export function Card(props: { children?: unknown }) { return <div /> }\n',
  'src/input.tsx': 'export function Input(props: { name?: string }) { return <input /> }\n',
};

const PAGE = `import { Badge, Button, ChevronLeft } from "@acme/ui";
import * as UI from "@acme/ui";

export function Page() {
  return (
    <main>
      <Button>Save</Button>
      <Button variant="danger" tone="quiet">Delete</Button>
      <UI.Card>Card</UI.Card>
      <Badge>New</Badge>
      <div className="bg-blue-500">Color</div>
      <button><ChevronLeft /></button>
    </main>
  );
}
`;
const COLOR_LINE = 11;
const ICON_BUTTON_LINE = 12;

const COMPONENT_RULES = [
  'no-unknown-component',
  'no-unknown-prop',
  'no-unknown-variant',
  'prefer-design-system-component',
];

const NOTICE = 'No design-system components found: the component rules did not run.';

/** An app that installs `pkg` as `@acme/ui`; with `react`, React's types are installed too. */
function installedApp(
  pkg: Record<string, string>,
  extra: Record<string, string> = {},
  react = false,
): string {
  return fixture(
    {
      'package.json': json({
        name: 'web',
        dependencies: { '@acme/ui': '1.0.0', ...(react ? { react: '19.0.0' } : {}) },
      }),
      ...(react ? { 'tsconfig.json': TSCONFIG } : {}),
      'app/page.tsx': PAGE,
      ...Object.fromEntries(
        Object.entries(pkg).map(([file, text]) => [`node_modules/@acme/ui/${file}`, text]),
      ),
      ...extra,
    },
    { nodeModules: react },
  );
}

type Results = { diagnostics: { ruleId: string; line: number; message: string }[] }[];

async function check(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, color: false, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await main(['check', 'app/page.tsx', '--format', 'json', '--no-cache'], io);
  const findings = (JSON.parse(out.join('\n')) as Results).flatMap((r) => r.diagnostics);
  return { code, findings, stderr: err.join('\n') };
}

describe('an app on a design-system package published without its sources', () => {
  it("does not call the package's components invented when its config sets importPath", async () => {
    const { findings, stderr } = await check(installedApp(DIST_ONLY));
    expect(findings.filter((d) => COMPONENT_RULES.includes(d.ruleId))).toEqual([]);
    // check says the component rules did not run, and says nothing else about them.
    expect(stderr).toContain(NOTICE);
    expect(stderr).not.toContain('not checked');
    // The token rules and the accessibility rule still run: the package's icon in a native
    // <button> is still an icon.
    expect(findings.map((d) => [d.ruleId, d.line])).toEqual([
      ['no-hardcoded-color', COLOR_LINE],
      ['icon-button-accessible-name', ICON_BUTTON_LINE],
    ]);
  });

  it("does the same with the package's config copied into the app", async () => {
    const config = json({
      components: ['node_modules/@acme/ui/src/**/*.tsx'],
      importPath: '@acme/ui',
      tokens: ['node_modules/@acme/ui/theme.css'],
    });
    const { findings, stderr } = await check(
      installedApp(DIST_ONLY, { 'onsystem.config.json': config }),
    );
    expect(findings.filter((d) => COMPONENT_RULES.includes(d.ruleId))).toEqual([]);
    expect(stderr).toContain(NOTICE);
    expect(findings.map((d) => d.ruleId)).toEqual([
      'no-hardcoded-color',
      'icon-button-accessible-name',
    ]);
  });

  for (const [what, pkg, react] of [
    ['their sources', WITH_SOURCES, false],
    ['their type declarations', WITH_DECLARATIONS, true],
  ] as const) {
    it(`still checks the components when the package publishes ${what}`, async () => {
      const { findings, stderr } = await check(installedApp(pkg, {}, react));
      expect(stderr).not.toContain(NOTICE);
      const components = findings
        .filter((d) => COMPONENT_RULES.includes(d.ruleId))
        .map((d) => [d.ruleId, d.line, d.message.split(/[.(]/)[0]?.trim()]);
      expect(components).toEqual(
        expect.arrayContaining([
          ['no-unknown-variant', 8, '"danger" is not a valid variant for <Button>'],
          ['no-unknown-prop', 8, '<Button> has no prop "tone"'],
          ['no-unknown-component', 10, '"Badge" is not a design-system component'],
        ]),
      );
      expect(
        components.filter(([, , message]) => /"(?:Button|Card)"/.test(String(message))),
      ).toEqual([]);
    });
  }
});
