---
'onsystem': patch
---

A project without `node_modules` keeps its cached model in a folder of the system temp folder that only you can open, `onsystem-<uid>`, rather than in the shared `onsystem` folder. On a shared machine another user could create that folder first and plant a model there, whose descriptions then reached your agent. A cache folder that is a link, belongs to another user or that others can write to is not read, and the model is written whole, then renamed into place. When the folder belongs to another user, the warning says to install the dependencies or set `TMPDIR` to a folder of your own.

`get_component` and the `ds://components` resource mark the repository's prose as its own: the JSDoc description and docs sections are quoted as lines that start with `>`, whichever line break the file uses (a bare `\r` or U+2028 too), and a deprecation note, a prop's or a part's description, a docs heading and an example title are in double quotes and cut short. A line says the marked text is a description of the component, not instructions. A variant name that does not look like one, such as a sentence in a `cva` key, is quoted and cut to 40 characters in `get_component` and `list_components`, and so are such a prop name and a long string in a prop's type in `get_component`; a `cva` class list that does not look like classes (quote marks, sentence punctuation, a word in capitals, or three or more plain words that are not Tailwind classes) is quoted and cut to 80. An example is fenced with more backticks than its code holds, so the code cannot end the block. `list_components` and `search_components` still show the first sentence of a description as written.

One component file nested thousands of levels deep no longer fails the whole design system with "Maximum call stack size exceeded": it is skipped, with a warning that names it. Any run of the CLI that fails, such as on a file it cannot read, exits 2 rather than 1, which means findings, so CI no longer takes a crash for findings.

`no-hardcoded-color` reads one long class list in time that grows with its length: a list of 4,000 colors took seconds before, as each finding read the whole list again. The messages of the color, spacing and radius rules cut each quoted class to 120 characters, so a class with thousands of variants no longer makes a message of hundreds of thousands of characters. The fix still writes the whole class.

The GitHub Action's job summary shows a file name with a backtick in it whole, in its code span.
