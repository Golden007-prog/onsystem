# Security

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability reporting](https://github.com/dgesteves/onsystem/security/advisories/new), not in a public issue. Include the version, how the server or CLI was run, and the smallest project or input that shows the problem. You get a reply within 2 working days.

## Supported versions

Fixes go to the latest minor release only, as a patch release of it, with an advisory once users can upgrade. On 0.x, a minor release can change behaviour, so upgrade to the latest minor to get a fix.

## Verifying a release

Every release is published to npm by this repository's release workflow (`.github/workflows/release.yml`, on `main`), through npm trusted publishing with [provenance](https://docs.npmjs.com/generating-provenance-statements): no token publishes it. To check what you installed, run this in the project:

```sh
npm audit signatures
```

It verifies the registry signature of every installed package and the attestations of those that have one, onsystem among them. The package page on npmjs.com shows the same provenance: the workflow and the commit it built. Each release has a tag, `onsystem@X.Y.Z`, and a GitHub release.

## What the tool trusts

- The server runs locally over stdio, opens no ports and makes no network requests of its own. `npx` downloads the package from npm when the client starts it.
- It reads files under the project root (components, tokens, docs, `tsconfig`, `tailwind.config`) and the workspace packages they point at. In `node_modules` it reads the config a design-system package declares, as JSON (never run), and the type declarations of a library it reads components from (MUI).
- It writes its cache, the baseline file (creating its folder) when you run `check --update-baseline` or `check --prune-baseline`, and the file `export --out` names. `init` writes `onsystem.config.json`; in a design-system package also `ONSYSTEM.md` and the `onsystem` field (and `files`) of `package.json`; and, when you say yes, an onsystem section in `AGENTS.md` and `CLAUDE.md`.
- The cache is in `node_modules/.cache/onsystem`. A project without `node_modules` has it in a folder of the system temp folder that only you can open (`onsystem-<uid>`): one that is a link, belongs to another user or that others can write to is not read, since on a shared machine a model planted there would reach your agent.
- Component, token and docs files are read only when their real path, links resolved, is in the project, the workspace or git repository it is in, the package whose declared config it takes on, or a package installed in a `node_modules` folder of those, which pnpm may link from a store elsewhere. A link, or a `../` or absolute path in the config, that leads anywhere else is skipped, and `inspect` and the server's log name it. The home folder, the folders above it and the filesystem root never count as the workspace, the repository or a package's folder. The `node_modules` rule is the trade-off for pnpm's store: a link committed inside `node_modules` is followed like an installed package, so it can reach a package installed in another project on the machine.
- To show a component's props, TypeScript reads the modules the component imports wherever they resolve, outside the project too. A literal type from such a file (`export const KEY = "..." as const`) can show in `get_component`.
- `check_ui` with a `path` reads only files inside the project root, symlinks resolved, and limits input size.
- What the repository wrote reaches the agent: JSDoc, docs pages, examples, names and class lists. `get_component` and the `ds://components` resource mark its prose: the JSDoc description and docs sections are Markdown quotes (lines that start with `>`), and a deprecation note, a prop's or a part's description, a docs heading and an example title are in double quotes and cut short. A variant or prop name that does not look like a name, or a `cva` class list that does not look like classes, is quoted and cut short too (a variant name in `list_components` as well). A line of the answer says the marked text is the repository's, to read as a description, not as instructions. Names, types, token values, file paths and ordinary class lists are shown as written, and an example is code in a fence it cannot close. Not marked yet: the first sentence of a description in `list_components` and `search_components`, and the repository's values in rule messages, such as the allowed values `no-unknown-variant` lists (`check_ui` and the plugin's hook). An agent reads the repository anyway; the marks keep its text from reading as onsystem's own answer.
- An `onsystem.config.ts`, `.mjs` or `.js` file (or one under the old `design-system-mcp.config` name) is imported, so it runs as code, like an ESLint config. A `tailwind.config` is parsed, never run. Treat the config file like any other code in the repository.

## The Claude Code plugin

The plugin's hook and server run in every project you open in Claude Code, so use them in repositories you trust, as you would an editor extension that runs a project's linter:

- Both import the project's `onsystem.config.ts`, `.mjs` or `.js`, as above.
- The hook runs the project's own install of the CLI when there is one (`node_modules/onsystem`, whose `bin` it runs with Node.js), whatever its version. Without one, it runs `npx` with the exact version the plugin was released with. The server runs `npx -y onsystem@<that version>`, which uses a project install of the same version.
- `npx` runs in the project folder, so the project's npm config applies to it, such as a `registry` in its `.npmrc`.
- The hook writes marker files in the system temp folder, so its notice is shown once per session and its pause after a failed `npx` holds.

## The GitHub Action

What it runs and the permissions it needs are in [required-check.md](docs/required-check.md). In short:

- It runs the onsystem the project installed (`node_modules/onsystem`, from `working-directory` up to the repository root), else `npx --yes onsystem@<the action's version>`. Pin a commit SHA to stay on one release of both.
- On `pull_request`, `pull_request_target` and `merge_group` it runs `git fetch` from `origin` for the history it needs to find the changed lines. It needs only `contents: read`.
- `check` imports the checked-out `onsystem.config.*`. Do not run it on `pull_request_target` with the pull request's head checked out: that runs a fork's config with the base repository's token.

Reports about any of these boundaries are welcome.
