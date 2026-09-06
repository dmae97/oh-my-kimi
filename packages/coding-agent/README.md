# OMK

Provider-neutral terminal coding agent with optional multi-agent orchestration, scoped tools, replayable sessions, and evidence-backed verification.

OMK supports interactive terminal use, non-interactive output, RPC integration, and an embeddable TypeScript SDK. It works with API-key and subscription providers without making one provider the control plane.

OMK targets state-of-the-art quality as a CLI coding-agent harness; it does not currently claim verified SOTA status. Comparative claims follow the same-model, reproducible protocol in [Turn metrics and harness evaluation](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/metrics.md).

## Install

Requires Node.js 22.19 or newer. Built-in local bash also requires `sandbox-exec` on macOS or `bwrap` plus unprivileged user namespaces on Linux. Enforcement is enabled by default and fails closed with `sandbox.backend_missing`; see [Containerization](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/containerization.md).

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version
omk
```

Run without a global install:

```bash
npx --ignore-scripts open-multi-agent-kit
```

The published package name remains `open-multi-agent-kit`; the command is `omk`.

## Quick Start

Start OMK in a project directory:

```bash
cd your-project
omk
```

Then:

1. Run `/login` to configure an OAuth subscription or API key.
2. Run `/model` to choose an available model.
3. Describe the change and the evidence required for completion.
4. Review tool calls, diffs, diagnostics, and test results before accepting the work.

OMK stores user configuration under `~/.omk/agent/` and project configuration under `.omk/`.

## Optional document compiler

Install `omk-book-to-skill` to compile documents into reusable skills without adding Python extractors to OMK core:

```bash
omk install npm:omk-book-to-skill@0.98.2
```

It provides compile, update, and verification commands plus a local SHA-256 provenance manifest. See [Book to Skill](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/book-to-skill.md).

## Providers & Models

OMK includes provider adapters for Anthropic, OpenAI Codex, Google, OpenCode, Kimi, Qwen, ZAI/GLM, native xAI/Grok, and other compatible services. Availability depends on the credentials and endpoints configured on the current machine.

- `/login` adds or selects credentials.
- `/logout` removes credentials for a selected provider.
- `/model` lists models available to the current credential set.
- NVIDIA NIM's `z-ai/glm-5.2` entry transmits reasoning effort, including `/think max`.
- Native `xai` accepts subscription OAuth from `/login` or `XAI_API_KEY` for API billing. Only OAuth exposes weekly SuperGrok usage/reset. See [Grok harness](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/grok-harness.md).
- The optional status rail shows independent provider quota windows when an official API or passive response signal is available.
- Missing quota values are shown as unavailable rather than estimated.

OAuth credentials are stored locally in `~/.omk/agent/auth.json`. Multi-account providers keep accounts separate and send requests only through the explicitly selected account.

Quota and billing-cycle errors are classified as rate limits and can switch to the first authenticated resilience candidate before retry. See [Provider resilience](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/provider-resilience.md).

See [Provider setup](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/providers.md) for provider-specific authentication, quota behavior, and environment variables.

### Kimi For Coding

Configure Kimi through `/login` or the documented Kimi API-key environment variable. Requests use the fixed provider endpoint selected by the provider adapter.

### Hugging Face

Set the documented Hugging Face token and select a compatible model. See the provider guide for current model and endpoint requirements.

## Interactive Mode

Type `/` in the editor to open command completion.

| Command | Description |
| --- | --- |
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Select a model |
| `/think` | Select a thinking level |
| `/settings` | Change interactive settings |
| `/resume` | Open a previous session |
| `/new` | Start a new session |
| `/session` | Show session path, messages, tokens, and cost |
| `/resource [probe\|policy]` | Show resource pressure and effective concurrency for this run |
| `/goal [objective]` | Show or set the durable goal; supports `checkpoint <json>`, `pause`, `resume`, evidence-gated `complete`, and `clear` |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new fork from a previous user message |
| `/clone` | Duplicate the current session at the current position |
| `/compact [prompt]` | Compact context, optionally with custom instructions |
| `/copy` | Copy the last assistant message |
| `/name <name>` | Set the session display name |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/export [file]` | Export the session |
| `/import <path.jsonl>` | Import a JSONL session and continue it |
| `/share` | Upload the session as a private GitHub gist |
| `/changelog` | Show version history |
| `/reload` | Reload project and user resources |
| `/hotkeys` | Show keyboard shortcuts |
| `/star` | Open the OMK GitHub repository |
| `/quit` | Exit OMK |

### Default Harness Safeguards

OMK warns from the third repeated identical tool call and blocks the sixth. It also repairs unmatched tool pairs before provider requests and adds guidance for supported Kimi, GLM, and Grok models. `OMK_IDENTICAL_LOOP`, `OMK_TOOL_PAIR_REPAIR`, and `OMK_PROMPT_PRESET` opt out; `OMK_GOAL_CONTROLLER` controls `/goal` and continuation.

See [Usage](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/usage.md) and [Keybindings](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/keybindings.md) for the complete interactive reference.

### Repository Understanding

`v0.97.0` introduced the OpenWiki workflow and policy, but its release artifact did not include the ignored corpus. The current interrupted corpus and partial checker remain worktree-only and blocked from trusted use pending exact source binding, output allowlisting, and pre-publication secret/private-path scans. `.understand-anything/` remains optional local advisory data. See [Runtime algorithms and direction](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/runtime-algorithms.md).

### Resource Governance

A built-in resource governor probes host capacity. Its default `observe` mode reports decisions without changing execution; opt-in `adaptive` and `strict` modes throttle tool and governed heavy-process concurrency. Inspect the current host with `/resource` or `omk doctor resources [--json]`, and aggregate bounded local observations with `omk doctor resources --report [--json]`; see [Settings](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/settings.md).

### Terminal Notifications

Interactive TTY sessions notify by sound after final prompt settlement by default. Successful prompts use a 5-second duration floor; failed and aborted/stopped outcomes notify immediately. Intermediate retries and continuations stay silent, and headless modes never play sound. Configure or disable this under `notifications.completionSound` or with `OMK_COMPLETION_SOUND=0`.

## Sessions

Sessions are append-only JSONL transcripts stored under `~/.omk/agent/sessions/`. OMK can resume, branch, export, and repair sessions without sending the transcript to a separate orchestration service.

Do not publish session files until you have reviewed them for source code, credentials, personal information, and private tool output.

### Scripted Session Inspection

```bash
omk sdk session status --json
omk sdk session tail [id] --limit 20
omk sdk session inspect [id]
omk sdk session send <id> "message"
```

These commands inspect or append to stored transcripts. `send` does not wake or execute an agent.

### Context Compaction

Automatic and manual compaction reduce older context while retaining recent conversation state. The current default compactor deterministically carries explicitly marked user rules outside LLM rewriting; custom hooks and unmarked prose remain unchanged. Cancellation restores queued user input without committing a partial summary.

See [Compaction](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/compaction.md).

## Configuration

### Context Files

OMK discovers project instructions such as `AGENTS.md` from the current directory and parent directories. Use `--no-context-files` when a clean session must not load project context.

### Prompt Caching

Provider prompt caching follows provider capabilities and configured retention. Cache metadata is local and bounded; provider-side retention remains subject to the provider's policy.

### Environment Variables

Credential, network, model, and runtime variables are documented in [Environment variables](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/environment-variables.md). Prefer the documented fixed provider endpoints for authenticated requests.

## CLI Reference

```bash
omk [options] [prompt]
omk --help
```

Common modes:

```bash
omk                         # interactive TUI
omk -p "summarize changes"  # print mode
omk --mode json "task"      # structured event stream
omk --rpc                    # JSONL RPC mode
omk doctor resources [--json] # current pressure and admission report
omk doctor resources --report [--json] # bounded local observation aggregate
omk stats [--dir <path>] [--json] # aggregate turn metrics for a project
```

### Skills Configuration

Skills load on demand from project and user directories. The global-only `defaultActiveSkills` setting keeps selected, user-scoped skills active in every prompt while their full instructions stay read-on-use. See [Skills](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/skills.md).

### Other Options

Use `omk --help` for the authoritative option list for the installed version. Avoid copying options from an unreleased branch into automation.

## RPC Mode

RPC mode reads JSON commands from standard input and emits JSON events to standard output. Use it when another process owns the UI or lifecycle.

See [RPC](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/rpc.md).

## SDK and Extensions

The TypeScript SDK exposes session creation, provider configuration, tools, event streams, durable-goal reducers, Goal/Core/Verified/Open/Next seam checkpoints, an explicit pass-gated advisory best-of-N judge, and policy helpers for compaction, retries, prompt budgets, cache transitions, and system-prompt assembly. Extensions can add commands, tools, UI components, themes, and resource loaders without patching OMK core.

`omk-protocol` provides the versioned `TaskSpec -> ExecutionAttempt -> Observation -> EvaluationResult -> RuntimeDecision` contracts and pure semantic reducers. See [Run Protocol v1](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/run-protocol.md) for the implemented scope and migration boundaries.

- [SDK](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/sdk.md)
- [Extensions](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/extensions.md)
- [Skills](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/skills.md)
- [Themes](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/themes.md)

## OMK + AdaptOrch

OMK is a local, MIT-licensed coding agent. AdaptOrch is an optional, separate
evidence and risk layer for changes an AI wrote: it runs a change in an isolated
copy of the project and reports what it touched, whether it ran, and what the
tests said before and after. Its free Starter tier is self-hosted and runs on
your own machine; a bring-your-own model key is required on every tier.

**[Review AdaptOrch plans →](https://adaptorch.com/?utm_source=npm&utm_medium=readme&utm_campaign=omk#pricing)** · [claim boundary](https://adaptorch.com/claim-boundary?utm_source=npm&utm_medium=readme&utm_campaign=omk)

AdaptOrch is a separate proprietary product and is not bundled with OMK. Its
published claim boundary states that it does **not** prove semantic correctness
(`correctness_claim=false`); it reports and never rewrites, selects, or merges
on your behalf. OMK does not require it.

## Security and Privacy

- Tool access is explicit and can be scoped by path or runtime policy.
- Default OS isolation covers AgentSession's built-in local bash only; it does not isolate other tools, extensions, custom code, or the OMK process.
- Default tests scrub provider credentials; live provider tests require `LIVE_E2E=1`.
- Subscription quota requests use fixed HTTPS provider origins.
- Passive quota observers do not block model streams.
- Logs and issue reports must not contain API keys, OAuth tokens, cookies, or full private transcripts.

Report vulnerabilities privately through the repository's GitHub security contact rather than a public issue.

## Development

```bash
git clone https://github.com/dmae97/omk.git
cd omk
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

See [Development](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/development.md) and [CONTRIBUTING.md](https://github.com/dmae97/omk/blob/main/CONTRIBUTING.md).

Release notes: [v0.98.2](https://github.com/dmae97/omk/blob/main/.github/RELEASE_NOTES_v0.98.2.md).

## License

MIT. See [LICENSE](https://github.com/dmae97/omk/blob/main/LICENSE).
