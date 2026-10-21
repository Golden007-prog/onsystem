# Design-system packages

A design-system team owns one package that many apps use. Set onsystem up once, in that package, and every app that depends on it finds the design system with no config of its own: in the CLI, the MCP server, the ESLint plugin, the agent plugin's hook and the GitHub Action. What an app checks depends on what it can read of the package: every rule from a workspace package, or from a published one that ships its component sources or their type declarations (`.d.ts`), and the token rules, but none of its components, from one that publishes compiled code without type declarations ([what apps get](#what-apps-get)). An app that has a config of its own reads it over the package's ([an app's own config](#an-apps-own-config)). A package named like a design system whose `exports` point at its component sources is read even without the setup ([without the config](#without-the-config)).

## Set up the package

Run `init` in the package's folder:

```sh
cd packages/ui
npx -y onsystem init
```

`init` treats the folder as a design-system package when zero config reads the components through the package's own `exports`, or when the package is named like one (`@acme/ui`, `@acme/design-system`, `acme-ui`), as apps look for it. There it writes:

- **`onsystem.config.json`**, from what zero config finds in the package, as in any project ([configuration](configuration.md#config-file)).
- **`"onsystem": "./onsystem.config.json"` in `package.json`**, which declares the config to the apps. When `package.json` lists `files`, the config is added to them, so it is published with the package.
- **`ONSYSTEM.md`**, for the apps' teams: how to see what their app finds, how to give their agents the plugin, the skill or the MCP server, and the CI check. An `ONSYSTEM.md` that is already there is kept, unless `--force` is passed.

Then it checks the package once and offers a baseline, as in any project. When `files` leaves out the component or token files (a package that publishes only `dist/`), `init` says so: apps that install the package from a registry will not find them, and read the components from the type declarations it publishes instead, when it names some (`types` in `package.json`). Commit what it wrote.

In a package that already has a config, `init` leaves it as it is (`--force` would replace it) and says to add the field by hand. The field names a JSON file in the package:

```json title="package.json"
{
  "name": "@acme/ui",
  "exports": { ".": "./dist/index.mjs" },
  "files": ["dist", "src", "onsystem.config.json"],
  "onsystem": "./onsystem.config.json"
}
```

## In the apps

An app looks through its `dependencies` and `devDependencies`. When one of them declares a config in its `package.json`, the app reads it, whether the package is a workspace package or installed in `node_modules`: an app without a config of its own takes it on, and one with a config of its own reads that over it ([an app's own config](#an-apps-own-config)). `inspect` says where the config comes from:

```text
config   ../../packages/ui/onsystem.config.json (declared by @acme/ui)
detected workspace package @acme/ui
```

`inspect --explain` names the package first among what zero config looked at.

- **Paths come from the package.** `components`, `exclude`, `tokens` and `docs` are relative to the package's folder, wherever the app finds it: `../../packages/ui`, or `node_modules/@acme/ui`. They stay in the package when it is installed, and in the workspace when it is a workspace package, so `../tokens/theme.css` in a sibling package works. A path that leaves them is ignored, with a warning.
- **`exclude` adds to the app's defaults.** The app still leaves out `node_modules`, `.d.ts` files, tests and stories, and the package's patterns are added. The package's components are found with its own list, as in the package.
- **Components.** When the config leaves `components` to zero config, the app reads the package as zero config reads a design-system package (step 3 of [zero config](configuration.md#zero-config)), whatever the package's name, and also when it is installed. When the config sets `components`, they are imported by `importPath` when it is set, else by the package's `exports`.
- **What applies to the app:** the rules' severities and options, `elements`, `importPath` and `libraries`.
- **What stays with the package:** `tsconfig` (the app keeps its own), `overrides` (their globs are about the package's files) and `includeDesignSystem`.
- **A missing file is not an error in the app.** A token file the config names that is not there matches nothing, since a published package ships only some of its files. In the package itself it is an error, so a typo is caught there.

A project reads up to two configs, the first over the second, and zero config fills in the fields neither sets:

1. Its own config file (`onsystem.config.json`, or another [config file](configuration.md#config-file) name), or one its own `package.json` names in `"onsystem"`. Without one, when it is checked from a [monorepo root](configuration.md#monorepo-roots), the root's config.
2. The config a dependency declares. When several do, the one the app's code imports most.

`check` from the app's folder reads no root config: a project without a config of its own reads the package's config alone there, and the root's over it from the root. The root itself reads no dependency's config: each project in it finds its own.

### An app's own config

An app's own config builds on the package's: each field it sets replaces the package's, and each it leaves out comes from there. `components` brings the package's `importPath`, `docs` and `elements` with it, so a config that sets `components` of its own takes none of those from the package; `tokens` and `libraries` come from the package unless the app's config sets them. Its `rules` apply over the package's, rule by rule, and its `overrides`, `exclude`, `tsconfig` and `includeDesignSystem` are its own, as the package's stay with the package. So a config that only changes a rule's severity, `{ "rules": { "no-hardcoded-color": "warn" } }`, keeps the package's components and tokens, and every other rule as the package sets it. A [monorepo root](configuration.md#monorepo-roots)'s config, from the root, builds on the package's the same way, so its `rules` and `overrides` (`"files": ["apps/admin/legacy/**"]`) apply in every app without a config of its own. `inspect` names both configs:

```text
config   onsystem.config.json, over node_modules/@acme/ui/onsystem.config.json (declared by @acme/ui)
```

`init --force` in an app on such a package writes a config with only `$schema` in it, for the app's own rules and overrides, and says what it builds on.

`"extends": false` in the app's config reads it alone. Zero config then fills in only the fields it leaves out, as in any project: it finds a package named like a design system, as a workspace package or installed in `node_modules` with `exports` that point at its component sources ([without the config](#without-the-config)), but not one named otherwise (`@acme/kit`) or one whose `exports` point at compiled code: of those, it reads only the type declarations a package publishes, when it declares its config ([what apps get](#what-apps-get)). So such a config that only changes a rule's severity can leave the app without the package's components and tokens, and `check` then says which rules did not run. Copy `components`, `importPath` and `tokens` from the package's config into the app's, with paths into the package: `node_modules/@acme/ui/src/**/*.tsx`, or `../../packages/ui/src/**/*.tsx` from a workspace app. `init` writes no `importPath` for a package that apps import by subpath (`@acme/ui/components/button`), so when the package's config has none, set it to the package's name (`@acme/ui`). Without it, `no-unknown-component`, `no-unknown-prop`, `no-unknown-variant`, and `icon-button-accessible-name` on the package's `<Button>`, check none of the app's imports from the package, and nothing says so. With it, the same rules run as with the package's config, but the imports that findings and `get_component` suggest name `@acme/ui`, not the subpath.

The declared config is read as JSON and never run, so a dependency cannot make an app run its code. A field that names a `.js` or `.ts` config, a file outside the package, or a file that does not exist is an error that names the package when it is a workspace package, which its team can fix; in an app with a config of its own, it is a warning, and that config is read alone. In a package installed in `node_modules`, the declaration is skipped with a warning, and the app is read as if the package declared none.

`check` and `inspect` print each warning once, on stderr (`::warning` with `--format github`). The MCP server logs it once, and the ESLint plugin writes it once to stderr.

## What apps get

An app that installs the package reads what was published, and onsystem reads components from their source or from their type declarations (`.d.ts`), as it reads the [published libraries](configuration.md#published-libraries-mui) it knows, never from compiled JavaScript. So the rules that run in an app depend on how it gets the package and what the package publishes:

| The app gets the package                                                                                                                            | Rules that run in the app                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| As a workspace package                                                                                                                              | All eight [rules](rules.md)                                                                                                                                                                                                                                                                                                                                         |
| From a registry, with the config, the token files and the component sources (`src/`) published                                                      | All eight                                                                                                                                                                                                                                                                                                                                                           |
| From a registry, with the config, the token files, compiled `dist/` and its type declarations (`.d.ts`) published, but not `src/`                   | All eight, from its type declarations                                                                                                                                                                                                                                                                                                                               |
| From a registry, with the config, the token files and compiled `dist/` published, but neither `src/` nor type declarations                          | `no-hardcoded-color`, `no-hardcoded-spacing` and `no-hardcoded-radius`, and `icon-button-accessible-name` on native elements                                                                                                                                                                                                                                        |
| From a registry, without the config, named like a design system (`@acme/ui`), with `exports` that point at the component sources (`./src/index.ts`) | All eight, through zero config ([without the config](#without-the-config))                                                                                                                                                                                                                                                                                          |
| From a registry, without the config, with `exports` that point at `dist/`, or named otherwise (`@acme/kit`)                                         | What zero config finds in the app itself, and nothing from the package, unless the package publishes type declarations and is named like a design system in the app's own npm scope (`@acme/ui` for `@acme/web`), or the app's `importPath` names it: then its components are read from them. A declaration whose config is not published is skipped with a warning |

In an app whose package publishes only `dist/`, the components are read from the type declarations it publishes (`types` in its `package.json`, or a `types` condition in its `exports`), with their props, variants and the elements they render, as a [published library](configuration.md#published-libraries-mui)'s are: every rule runs, and agents find the components with `list_components`, `search_components` and `get_component`. `inspect` says so on its `library` line: `library  Design-system package (@acme/ui 1.0.0): 3 components from its type declarations`. Declarations carry no classes, so the components' classes and CSS variables are not known ([how it works](how-it-works.md)).

When the package publishes no type declarations either:

- **No component is known.** `no-unknown-component`, `no-unknown-prop` and `no-unknown-variant` check none of the components the app imports from the package, `prefer-design-system-component` reports nothing, `icon-button-accessible-name` does not know that the package's `<Button>` renders a button, and agents find no component with `list_components`, `search_components` or `get_component`. `check` says `No design-system components found: the component rules did not run.`
- **`importPath` does not turn the component rules on**, with no declarations to read. `init` sets it when apps import the package by one name, such as `@acme/ui`. With no component to compare against, imports from the package are not checked: `<Badge>` from `@acme/ui` is not reported, although the package has no `Badge`. It still tells `icon-button-accessible-name` that an icon the package re-exports is an icon, so `<button><ChevronLeft /></button>`, with `ChevronLeft` from `@acme/ui`, is reported for having no accessible name. Without `importPath`, that button is not reported.
- **The token rules check against the published tokens:** `no-hardcoded-color` when they hold colors, `no-hardcoded-spacing` and `no-hardcoded-radius` when they set a spacing scale and radii.
- **`--require-design-system` fails** (exit code 2), and it is on by default in the [GitHub Action](required-check.md).

The CLI, the MCP server, the ESLint plugin, the hook and the Action read the package the same way, so this holds in each. To give these apps every rule, publish the type declarations with `dist/`, or add `src/` to `files` in `package.json`; `init` says when `files` leaves out the component or token files, and whether apps then read the components from type declarations.

### Without the config

An app reads an installed package that declares no config, or whose declared config is not published, as zero config reads a workspace package (step 3 of [zero config](configuration.md#zero-config)), when the package is named like a design system (`@acme/ui`, `@acme/ui-kit`, `@acme/design-system`, `acme-ui`) and its `exports` point at the `.tsx` or `.jsx` sources it publishes: directly (`"./components/*": "./src/components/*.tsx"`) or through barrels (`".": "./src/index.ts"`). Its `exports` are read through the conditions an app resolves: those of Node.js (`import`, `require`, `module-sync`, `node`, `default`), and `module`, `browser` and `style`. A condition for the package's own repository, such as `source` (react-native-builder-bob) or `expo-source` (`@expo/ui`), is passed over: `{ "source": "./src/index.tsx", "default": "./lib/module/index.js" }` points at build output, which is what an app that installs the package gets. Unlike in a workspace package, exports that point at `dist/` are not followed back to `src/`: a component kit published with `src/` next to `dist/` for its source maps is not the app's design system, even when it is named like one (`@acme/react-ui`). Nothing compiled in the package is read: no JavaScript, JSX or CSS in a build folder (`dist/`, `build/`, `lib/`, `out/`, `esm/`, `cjs/`), and no export that points at JavaScript in any other folder (`./index.js`, `./es/index.mjs`, `./build-module/index.js`), whose re-exports are not followed. So a package that publishes a `.js` barrel in front of its `.jsx` files is not read either; point its `exports` at the `.jsx` files, or declare the config. `inspect --explain` says which it was: `found  installed package @acme/ui: node_modules/@acme/ui, 3 component files`, or `no     installed package @acme/ui: its exports point at build output (node_modules/@acme/ui/dist/index.mjs), not at component sources, and only sources are read`.

- **It is read where it really is.** With pnpm, that is its folder in `node_modules/.pnpm`, where pnpm also installs the packages it depends on, so the props its components take from them are known. When pnpm's store is outside the project, the package is read through the app's `node_modules`; there, the props its components take from their own dependencies are not known.
- **Its exported stylesheets are the tokens** (`"./globals.css": "./src/styles/globals.css"`), with the stylesheets of the package that they `@import`, but none in a build folder: `"./styles.css": "./dist/index.css"` is compiled, and brings no tokens. Only the first condition an app resolves counts, as for components: `"./x.css": { "style": "./dist/x.css", "default": "./src/x.css" }` gives apps the compiled `dist/x.css`, so `src/x.css` brings no tokens either. Other installed packages are not read: `@import "tailwindcss"` in them brings none of Tailwind's palette. An app whose config names the package's components but no `tokens` gets them through its own stylesheet, whose `@import "@acme/ui/globals.css"` is followed into `node_modules`.
- **A package named otherwise, or one whose `exports` point at compiled code, needs the config,** or type declarations that are read without it (in the app's own npm scope, or named by its `importPath`), as does anything beyond components and tokens: the rules' severities, `elements`, `importPath` and `libraries`.

## On real code

The [corpus](../corpus) runs `init --yes` in Dub's `@dub/ui`, a workspace package that Dub also publishes, then checks Dub's app, which has no config of its own (the `dub-web-package` run). The app takes on the config `@dub/ui` declares, and reports what zero config reports, file for file.
