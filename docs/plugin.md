# Claude Code plugin

The plugin is the fastest way to keep Claude on your design system. It bundles three things:

- **A hook** that runs `onsystem check` on every `.tsx` or `.jsx` file Claude writes or edits, and hands the errors back so they get fixed in the same turn instead of in review.
- **The MCP server**, so Claude can look components, props, variants and tokens up before it writes.
- **A skill** that tells Claude to do that, and to fix every `check_ui` finding. It loads by itself for UI work, or run `/onsystem:onsystem`.

```text
/plugin marketplace add dgesteves/onsystem
/plugin install onsystem@dgesteves
```

## What Claude sees when an edit breaks the design system

```text
⏺ Write(app/promo/page.tsx)
  ⎿  PostToolUse hook: app/promo/page.tsx breaks the project's design system
     1:58 error [no-hardcoded-color] Hardcoded color `bg-[#f5f5f5]` → `bg-muted`.
     1:77 error [prefer-design-system-component] Native <button> where the design system has <Button>.
     …
⏺ The hook flagged five issues. Looking up Button and the color tokens before fixing.
⏺ onsystem - get_component (MCP)(name: "Button")
⏺ Write(app/promo/page.tsx)   →   <Button variant="destructive"> on bg-muted, hook passes
```

## What the hook does

- **Errors come back to be fixed.** The hook runs after the file is written. It exits with Claude Code's blocking-error code, and the findings, each with its fix, go to Claude, which corrects the file before moving on.
- **Warnings don't.** They reach Claude as a note, without blocking.
- **Only what Claude just changed.** After an Edit it lists the findings on the lines the edit changed, not the unchanged lines it repeats around them, and only counts older ones. When it can't tell which lines those are (the new text is in the file more than once, or a formatter rewrote it), it passes the findings on as a note and doesn't block. It honours a [baseline](ci.md#adopting-it-in-an-existing-codebase).
- **Quiet where there is nothing to check.** It stays silent in projects without design-system components (tokens alone don't count) or a config, so installing the plugin for every project is safe. A config that a dependency declares counts: in an app on a [design-system package](design-system-packages.md#what-apps-get) that publishes only compiled code, the hook checks the components it reads from the package's type declarations, and the tokens, and their errors block; when the package publishes no type declarations, it checks no component of the package, only the tokens and native elements.
- **The design system's own files are left alone.** Like `check`, it skips them: an edit to `components/ui/button.tsx` changes the design system, which is a call for you and your reviewers rather than a lint error.
- **So is what `check .` leaves out.** A file the config's `exclude` covers, tests and stories by default (`*.test.tsx`, `*.stories.tsx`, `__tests__` folders) or a folder you list such as `app/legacy`, is not checked: the hook runs `check --skip-excluded`, which leaves such a file out even though it is named. Add a folder to `exclude` to keep the hook off code you don't hold to the design system. A project's own install from before that flag checks the file, as it did before.
- **It says when it can't check.** When the CLI can't run (npx can't fetch it because of a [min-release-age policy](troubleshooting.md#a-min-release-age-policy-blocks-npx), a private registry or no network, or the config is broken), it says so once per session and project, as a message to you, and never blocks the edit. When npm could not reach the registry, or npx didn't finish within the hook's 55 seconds, the hook doesn't start npx again for ten minutes, so an offline session waits for npm once, not on every edit.
- **Codex runs it too.** Codex installs this plugin from the same marketplace (`codex plugin add onsystem@dgesteves`) and runs the hook after each `apply_patch`, once you trust it in `/hooks`. It checks every `.tsx` or `.jsx` file the patch adds or updates, a moved file where it moved to, and holds an updated file to the lines its hunks change, as it holds an Edit. A patch's files are checked in one run per project.
- **Monorepos work.** The hook finds the project from the edited file, not from where Claude started, and the MCP server started at the root serves every project, answering for the file's own project when the tools get its `path`. When the monorepo root has a config or a baseline, as `init` there writes them, the hook runs the check from the root, as `check .` there does: the root config's rules apply to every project without a config of its own, and the root baseline covers every project. Since every project without a config of its own takes the root config on, the hook also checks a project without design-system components there, as `check .` at the root does (with neither components nor color tokens, only the accessibility rule runs in it). A project with a baseline of its own, as a CI job per app keeps, is checked from its own folder, and so is every project when the root is one project with a design system of its own (its config sets `components`, or it has a `components.json` or a `components/ui` folder), so each project's own components are still its design system.

## What it runs, and what it touches

The hook and the server run the `onsystem` package at the plugin's exact version: the project's own install when there is one (`npm install --save-dev onsystem`), else `npx`. Both run through Node.js directly, never a shell. They read the project's files and write only the cache (`node_modules/.cache/onsystem`, or the system temp folder) and marker files in the system temp folder, so the hook's notice is shown once and its pause holds. onsystem makes no network requests and no model calls. The only network access is npm's, when it runs through npx:

- **The hook** runs `npx --prefer-offline`, which uses the package in npm's cache without asking the registry: after the first download it checks offline too. If npm itself fails there, as when its cached list of versions predates a new release of the plugin, it runs once more with `--prefer-online`, which asks the registry. When the CLI ran and failed, as with a broken config, the hook says so at once, without a second run.
- **The server** runs `npx -y onsystem@<version>`, which asks the registry about the package each time it starts. Offline, it starts from npm's cache only after npm gives up on the registry, over a minute later.
- **A project install** needs no network and is the fastest: the hook runs it without npm, and the server's npx uses it when it is the plugin's version.

## Coming from the design-system plugin

The plugin was called `design-system` before 0.4.0. Replace it:

```text
/plugin uninstall design-system@dgesteves
/plugin marketplace update dgesteves
/plugin install onsystem@dgesteves
```

If you added the server with `claude mcp add` as well, remove that entry (`claude mcp remove onsystem`, or `claude mcp remove design-system` from before the rename) to avoid two copies of the tools. The [migration guide](migrating.md) lists everything else that moved.
