---
'onsystem': minor
---

An app's own config builds on the config its design-system package declares, instead of replacing it. What the app's config leaves out comes from the package's: `components`, with the package's `importPath`, `docs` and `elements` unless the app's config sets `components` of its own; `tokens`; and `libraries`. Its `rules` apply over the package's, rule by rule, and its `overrides`, `exclude`, `tsconfig` and `includeDesignSystem` are its own. Before, an app config that only turned one rule to `"warn"` lost the package's components and color tokens: in an app that installs the package, `check` said `No design system found` and passed. `inspect` names both configs (`config   onsystem.config.json, over node_modules/@acme/ui/onsystem.config.json (declared by @acme/ui)`). `"extends": false` in the app's config reads it alone, as before. This can change what `check` reports in an app with a config of its own whose dependency declares one: it now gets the package's components, tokens and rules where its config leaves them out. A workspace package whose `"onsystem"` field cannot be read is a warning in such an app, which then reads its own config alone, and still an error in an app without one.

A monorepo root's config builds on a project's design-system package config the same way in `check` and `inspect` from the root, so its `rules` and `overrides` apply to every project without a config of its own. Before, the config a project's design-system package declared took their place, without a word. From the project's folder, the root's config is still not read.

`init --force` in an app on such a package writes a config with only `$schema`, for the app's own rules and overrides, and keeps the package's components, `importPath`, tokens and rules. Before, it wrote the package's paths into the app's config, or a config that lost the package's components.

`init` in an app whose design system zero config reads from an installed package leaves `components` and `tokens` to zero config. It wrote paths into the package's folder, which pnpm names by version (`node_modules/.pnpm/@acme+ui@1.0.0_react@19.0.0/node_modules/@acme/ui/…`), so after an upgrade `check` failed with `Token file not found`, and the component files it listed matched nothing.

In a design-system package whose `files` leave out its component sources, `init` says that apps installing it read its components from the type declarations it publishes, when its `package.json` names some. It said they get no component checks, which holds only without type declarations.
