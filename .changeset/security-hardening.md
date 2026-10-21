---
'onsystem': patch
---

A project without `node_modules` keeps its cached model in a folder of the system temp folder that only you can open, `onsystem-<uid>`, rather than in the shared `onsystem` folder. On a shared machine another user could create that folder first and plant a model there, whose descriptions then reached your agent. A cache folder that is a link, belongs to another user or that others can write to is not read, and the model is written whole, then renamed into place.

`get_component` quotes the repository's JSDoc and docs (lines that start with `>`) and says they are a description of the component, not instructions. A variant name that does not look like one, such as a sentence in a `cva` key, is quoted and cut to 40 characters in `get_component` and `list_components`, and so is a long string in a prop's type. An example is fenced with more backticks than its code holds, so the code cannot end the block.

One component file nested thousands of levels deep no longer fails the whole design system with "Maximum call stack size exceeded": it is skipped, with a warning that names it. Any run of the CLI that fails, such as on a file it cannot read, exits 2 rather than 1, which means findings, so CI no longer takes a crash for findings.

`no-hardcoded-color` reads one long class list in time that grows with its length: a list of 4,000 colors took seconds before, as each finding read the whole list again. The messages of the color, spacing and radius rules cut each quoted class to 120 characters, so a class with thousands of variants no longer makes a message of hundreds of thousands of characters. The fix still writes the whole class.

The GitHub Action's job summary shows a file name with a backtick in it whole, in its code span.
