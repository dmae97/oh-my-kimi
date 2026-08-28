# CLI-Anything commands

Slash commands that load the [`cli-anything`](../../skills/cli-anything/SKILL.md) skill
with a target already filled in.

| Command | Does |
| --- | --- |
| `/cli-anything <path-or-repo>` | Build a CLI harness for GUI-only software |
| `/cli-anything:refine <harness-path> [focus]` | Widen an existing harness's coverage |
| `/cli-anything:test <harness-path>` | Verify a harness renders what it claims |

Each command validates that a target was given, then sends the agent `!skill:cli-anything`
plus the target. The skill carries the procedure; this extension only saves typing.

## Why it does not vendor the upstream spec

Upstream's Pi extension injects a vendored copy of its harness specification into every
command. This one does not. OMK loads skills on demand, so the same content belongs in a
skill, and copying an Apache-2.0 document into an MIT repository would add attribution
obligations plus a second copy to keep in step with upstream — for no gain.

## Install

The extension is discovered automatically when OMK runs from this repository checkout.
Elsewhere, point `--extension` at `index.ts` or add the directory to your settings.

Methodology from [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) (Apache-2.0).
