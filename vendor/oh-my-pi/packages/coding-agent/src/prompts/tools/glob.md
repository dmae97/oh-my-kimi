Globs files and directories via fast pattern matching, any codebase size.

<instruction>
- `path`: a glob, file, or directory. Search several at once by passing a semicolon-delimited list (`src/**/*.ts; test/**/*.ts`).
- `gitignore` (default `true`) hides `.gitignore` matches. Set `gitignore: false` to find `.env*`, `*.log`, fresh build outputs, or anything your repo ignores.
- `hidden` (default `true`); combine with `gitignore: false` to surface dotfiles also gitignored.
</instruction>

<output>
Matching paths sorted by mtime (newest first), grouped under `# <dir>/` headers with basenames below; directories get a trailing `/`.
</output>

<avoid>
Open-ended searches needing multiple rounds of globbing/searching: you MUST use the Task tool instead.
</avoid>
