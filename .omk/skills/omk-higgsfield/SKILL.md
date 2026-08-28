---
name: omk-higgsfield
description: Drive the Higgsfield CLI to generate images, video, 3D, audio, voices, and dubbing, train Soul ID characters, run marketing-studio and product-photoshoot workflows, and scaffold or deploy full-stack websites and browser games. Use when a task needs generated media or a Higgsfield-hosted site, when asked to run `higgsfield` commands, or when a workflow needs model, workflow, voice, or preset discovery. Requires the `higgsfield` binary and an authenticated session; credits are consumed per job.
---

# Higgsfield CLI

A hosted media-generation CLI: 40+ image, video, 3D, and audio models, plus site and
game deployment.

## Discover, do not memorize

The catalog moves. Every parameter question has a command that answers it against the
live service, and the answer is authoritative in a way this document cannot be:

```bash
higgsfield model list              # current model catalog
higgsfield model <name>            # parameter schema for one model
higgsfield workflow list           # available workflows
higgsfield workflow get <name>     # workflow parameters; --json to parse
higgsfield voices                  # voices for text2speech and voice-change
higgsfield preset                  # server-managed styles and actions
```

`Unknown model "<name>"` means the catalog changed. Run `model list` rather than
guessing a near-miss name. Every subcommand takes `--help`.

## Setup

```bash
curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh
# or: brew install higgsfield-ai/tap/higgsfield
# or: npm install -g @higgsfield/cli
higgsfield auth login
```

Sessions are short-lived. `Session expired` or `Not authenticated` mid-task means
re-run `auth login`, not that the command was wrong.

## Generate

```bash
higgsfield generate create <model> --prompt "..." --wait
```

`--wait` blocks until the job finishes and prints the result URL. Without it you get a
job id and poll with `generate get`. Use `generate cost` before a large batch: jobs
consume credits, and `higgsfield account` shows the balance.

Feed local files in with `higgsfield upload` and pass the returned reference.

## Capability areas

Each has its own subcommand with its own `--help`. Reach for these rather than trying
to express the task as a bare `generate`:

| Need | Command |
| --- | --- |
| Consistent character across generations | `higgsfield soul-id` |
| Branded ads, avatars, brand kits, DTC ads | `higgsfield marketing-studio` |
| Product imagery with mode-specific enhancement | `higgsfield product-photoshoot` |
| Full-stack site or app, deploy, secrets, DB | `higgsfield website` |
| Browser-game ZIP deploy and marketplace listing | `higgsfield game` |
| Billing workspace selection | `higgsfield workspace` |

`higgsfield website` scaffolds a git repository you clone, edit under `app/`, and push;
`deploy` ships it and must be re-run after every change. `publish` only lists the site
on the community feed — it does not deploy.

## Before spending credits

Generation is billable and not idempotent: a retried prompt is a second charge, not a
cached result. Check `generate cost` for anything batched, and confirm the model name
with `model list` first — a typo that falls through to a different model still bills.

## Upstream

[higgsfield-ai/cli](https://github.com/higgsfield-ai/cli) (MIT). Per-model parameters
and enums live in that repository's `MODELS.md`; the live catalog is `model list`.
