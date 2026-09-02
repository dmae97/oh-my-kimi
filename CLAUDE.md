# CLAUDE.md

@AGENTS.md

<!--
Maintainer note (stripped before this file enters Claude's context):
the bare `@AGENTS.md` line above is an import, not a mention. Keep it un-backticked and
outside any code fence or Claude Code will treat it as literal text and load nothing.
-->

Claude Code project memory for the OMK monorepo, following Anthropic's
[memory convention](https://docs.claude.com/en/docs/claude-code/memory).

The import above is the entire rule set. [`AGENTS.md`](AGENTS.md) is this repository's
single source of behavioral truth for layout, commands, code style, git discipline,
release, and the publication boundary; Claude Code loads it here so both hosts read the
same instructions. Do not restate its rules below — a copy that drifts is worse than no
copy, and that drift is why this file was reduced to an import.

## Claude-specific notes

- OMK's own CLI reads `AGENTS.md` and never loads `CLAUDE.md` from a directory holding
  both, so anything written below this line is invisible to an OMK session. If a rule
  needs to reach every agent, it belongs in `AGENTS.md`.
- Personal, machine-local preferences go in an untracked `CLAUDE.local.md`. Nothing
  personal belongs in this file — see [Publication boundary](AGENTS.md#publication-boundary).
- The OpenWiki workflow may not write to `AGENTS.md`, `CLAUDE.md`, or its own workflow
  file; its output gate admits `openwiki/` alone. A change to this file is authored by a
  human or a session acting for one.
- This file carries no Anthropic system prompt, tool schema, or safety policy. Those are
  owned by Anthropic, are not verifiable from this repository, and are out of scope for a
  repo-local memory file. An earlier revision claimed to reproduce one; it was removed as
  unverifiable and must not be restored.

<!-- OPENWIKI:START -->

## OpenWiki

See [AGENTS.md](AGENTS.md) for OpenWiki agent instructions.

<!-- OPENWIKI:END -->
