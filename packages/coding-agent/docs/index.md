# OMK Documentation

OMK is a provider-neutral coding agent with multi-agent orchestration, durable harness controls, replayable sessions, SDK/RPC integration, and evidence-backed verification. Its core stays small while extensions, skills, prompts, themes, and packages add workflows.

## Quick start

Install OMK with npm:

```bash
npm install -g --ignore-scripts open-multi-agent-kit
```

`--ignore-scripts` disables dependency lifecycle scripts during install. OMK does not require install scripts for normal npm installs.

To uninstall omk itself, use npm:

```bash
npm uninstall -g open-multi-agent-kit
```

For pnpm, Yarn, or Bun installs, use the matching global remove command: `pnpm remove -g open-multi-agent-kit`, `yarn global remove open-multi-agent-kit`, or `bun uninstall -g open-multi-agent-kit`.

Then run it in a project directory:

```bash
omk
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting omk.

For the full first-run flow, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using OMK](usage.md) - interactive mode, `/goal`, default harness safeguards, context files, and CLI reference.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [Provider Resilience](provider-resilience.md) - retry, failover, quota, and safety-stop recovery.
- [Native xAI Grok](grok-harness.md) - authentication, weekly SuperGrok usage, presets, and thinking tiers.
- [Containerization](containerization.md) - sandbox omk with OpenShell, Gondolin, or Docker.
- [Settings](settings.md) - global and project settings.
- [Environment Variables](environment-variables.md) - process configuration, harness opt-outs, and bash-tool session environment.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Book to Skill](book-to-skill.md) - optional document-to-skill compiler with local provenance checks.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [OMK packages](packages.md) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Automation and control

- [SDK and Session Control](sdk.md) - embed omk, reuse policy helpers, or inspect stored sessions from scripts.
- [Run Protocol and Durable Goals](run-protocol.md) - canonical run contracts and the durable-goal lifecycle.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Session format](session-format.md) - JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, project structure, and debugging.
