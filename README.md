# OMK

Run multiple coding agents safely in one repo.

OMK turns a coding task into a scoped DAG run: it routes the right model, limits tool access, requires evidence, and saves replayable artifacts before claiming success.

Use it when one agent is too loose, too risky, or too hard to audit.

<p>
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="npm version" src="https://img.shields.io/npm/v/open-multi-agent-kit?color=00D6FF"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="proof/PROOF_INDEX.md"><img alt="proof check" src="https://img.shields.io/badge/proof--check-source-00FFC2"></a>
  <a href="https://github.com/dmae97/open-multi-agent-kit/discussions"><img alt="discussions" src="https://img.shields.io/badge/discussions-open-9D4EDD"></a>
</p>

## 30-second demo

```bash
npx -y -p open-multi-agent-kit omk do "review this repo for release risk" --dry-run --json
```

OMK should produce a bounded plan before changing files:

```txt
goal
  review this repo for release risk

flow
  goal -> input envelope -> DAG -> scoped lanes -> evidence -> verify

artifacts (dry run)
  .omk/runs/<run-id>/input-envelope.json
  .omk/runs/<run-id>/dag.json
  .omk/runs/<run-id>/dag-compile-report.json
```

Executing (not dry-run) adds loop artifacts such as `.omk/runs/<run-id>/loop-state.json` and `.omk/runs/<run-id>/loop-decisions.jsonl`. Artifact names can evolve with the runtime contract; the invariant is that OMK persists reviewable run state before a worker claims completion.

## Install

```bash
npm install -g open-multi-agent-kit
omk init
omk doctor
omk chat
```

For local verification from a checkout:

```bash
npm ci
npm run build
node dist/cli.js do "explain this repo" --dry-run --json
npm run verify:no-kimi
```

## Use OMK if you

- use Codex, Claude Code, OpenCode, DeepSeek, Qwen, OpenRouter, MiMo, or local models in the same repo;
- want agents to produce evidence before saying “done”;
- need read/write/shell authority separated by task;
- want replayable `.omk/runs/` artifacts for review;
- need project-scoped MCP, skills, hooks, and provider lanes instead of ambient global tool access.

## How OMK differs

| Tool type | Good at | Missing piece | OMK adds |
| --- | --- | --- | --- |
| Codex / Claude Code | Strong single-agent execution | Audit and routing layer | DAG, evidence, replay |
| OpenCode | Terminal coding loop | Multi-provider governance | Provider authority + gates |
| MCP servers | Tool access | Task-level control | Scoped MCP per lane |
| CI | Post-hoc verification | Agent-time enforcement | Evidence before completion |

## What OMK controls

```text
Goal → DAG plan → scoped lanes → evidence bundle → verify gate → replay / inspect
```

- **Routing**: choose a compatible provider/runtime for the task.
- **Authority**: keep read, write, shell, and merge powers explicit.
- **Evidence**: require command output, diff, artifact, metric, or review proof.
- **Replay**: save run artifacts under `.omk/runs/<run-id>/` for review.
- **Scope**: keep MCP servers, skills, hooks, and memory bounded per lane.

## Examples

- [Codex MCP evidence run](examples/codex-mcp-evidence-run/): project-scoped MCP setup plus evidence-gated DAG dry run.
- [Provider fallback](examples/provider-fallback/): `--provider auto` routing with fallback planning.
- [Proof index](proof/PROOF_INDEX.md): source-controlled proof bundles checked by `npm run proof:check`.

## Maturity and safety claims

Current source version: `open-multi-agent-kit@0.78.8`.

- Public package name: `open-multi-agent-kit`.
- Runtime contract family: `v1.2` means contract family, not a stable npm `1.x` release.
- Release channel: `pre-1.0`.
- OS-level sandboxing is planned, not claimed; child env hardening and approval gates are adapter-specific.
- registry verification: treat npm `latest` claims as valid only after tagged CI and registry checks pass.

See [versioning](docs/versioning.md), [provider maturity](docs/provider-maturity.md), and [SECURITY.md](SECURITY.md).

## Community

- Ask setup and provider questions in [Discussions](https://github.com/dmae97/open-multi-agent-kit/discussions).
- File reproducible bugs in [Issues](https://github.com/dmae97/open-multi-agent-kit/issues).
- If you want safer multi-agent coding runs, star the repo to follow the `v0.8` release line.

## License

[MIT](LICENSE)
