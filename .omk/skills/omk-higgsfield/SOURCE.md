# SOURCE — omk-higgsfield skill

## Upstream

- **Repo:** https://github.com/higgsfield-ai/cli
- **Pin (commit hash):** `8827135df7601667f66cd36ce84cf72106d690c4`
- **Branch:** `main`
- **Date:** 2026-07-18
- **Commit subject:** `docs(website): document required --category flag + website categories command`
- **License:** MIT

## What was taken

The command surface only: subcommand names, their stated purposes, the install and
auth sequence, and the two documented failure modes (expired session, unknown model).
These are interface facts, and a skill that states them differently is simply wrong.

`SKILL.md` is original prose, not a port. No upstream file is vendored here, so there
is no third-party copy in this directory to keep in step — but the command surface it
describes is pinned to the commit above.

## What was deliberately left out

- **The model list.** Upstream ships 40+ models across image, video, 3D, and audio, and
  its own troubleshooting tells the reader to run `higgsfield model list` when a name
  fails. A copy in this repository would be stale on the first catalog change and would
  read as authoritative while being wrong.
- **Per-model parameters and enums.** Same reason; `higgsfield model <name>` and
  `higgsfield workflow get <name> --json` answer against the live service.

## Re-checking this skill

Compare `higgsfield <command> --help` against the capability table in `SKILL.md`. A new
top-level subcommand is the signal to update; a new model is not.
