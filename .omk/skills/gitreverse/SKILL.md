---
name: gitreverse
description: Turn a public GitHub repository into a single synthetic user prompt that someone might paste into Cursor, Claude Code, Codex, etc. to vibe-code the project from scratch. Use when the user references a GitHub URL or `owner/repo` slug together with prompt reconstruction, vibe coding, or rebuild-from-scratch intent. Route source: https://github.com/filiksyos/gitreverse
argument-hint: "<owner/repo or github url>"
---

# GitReverse — repository to prompt

Reverse a **public GitHub repository** into **one short, conversational user
prompt** grounded in real repo context. This ports the GitReverse flow
(https://github.com/filiksyos/gitreverse) into an OMK skill: pull repo
metadata, a depth-1 root file tree, and the README, then synthesize the
single prompt a person could paste into an AI coding agent to rebuild the
project from scratch.

## Core workflow

1. Parse the target: accept a full GitHub URL (`https://github.com/owner/repo`,
   including `/tree/...` paths — use the whole repo for now) or an `owner/repo`
   slug. GitHub-style `tree` subpaths are NOT scoped yet; the reverse flow uses
   the whole repo.
2. Verify visibility: only **public** repositories. If the repo 404s, is
   private, or requires auth to read, stop and report it as a blocker.
3. Fetch exactly three evidence surfaces:
   - repo metadata (owner, name, description, primary language, topics)
   - root file tree at depth 1 (top-level files and directories)
   - README (rendered to text)
4. Synthesize **one** short, conversational prompt grounded in that context.
   It describes what to build, not how to copy it — no file dumps, no
   verbatim README paste, no system prompts.
5. Cite evidence: name which facts came from metadata vs. file tree vs.
   README, and keep observed facts clearly separated from synthesized text.

## Tool selection

- Tools: `gh` or `git` for local checks; plain HTTPS `fetch` against
  `api.github.com` is enough (metadata, git/trees, readmes endpoints)
- MCP: `github`, `filesystem`
- Hooks: `protect-secrets`, `stop-verify`

## Safety constraints

- Public repositories only. Never fetch, mirror, or echo private repo
  contents even if a token is available.
- If a README or file listing exposes secrets (tokens, keys, credentials),
  do not copy them into the prompt; redact and note the finding.
- The output is a user prompt, not documentation or a system prompt.
- Rate limits: prefer unauthenticated GitHub API and few requests; set a
  token only if the user provides one for higher limits.

## Acceptance

- Repository owner/name is parsed from the URL or slug before any fetch
- The generated prompt is grounded in README and file-tree evidence
- Only public repository data is used; private or credential-bearing
  content is refused and redacted
- Observed repo facts and synthesized prompt text are clearly separated
- Output is exactly one conversational prompt plus an evidence section
