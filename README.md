# OMK

Project-aware AI coding runtime.

Install once. Resume every project. Route to the best coding model.

## Install

```bash
curl -fsSL https://get.omk.dev | sh
```

Inspect before running:
```bash
curl -fsSL https://get.omk.dev/install.sh
```

## Website

[omk.dev](https://omk.dev) — docs, model lanes, privacy, enterprise relay

## What it does

- **Project memory** — resumes context across sessions
- **Model routing** — auto-selects DeepSeek Flash, MiMo, Kimi, Claude, Codex by task complexity
- **MCP orchestration** — auto-connects project MCP servers, skills, hooks
- **Consent & governance** — granular opt-in levels (L0-L4), never auto-opt-in

## Quick start

```bash
omk init          # detect project, choose runtime mode
omk               # start coding
omk consent       # privacy settings
```

## Security

- Safe by default: child env is sanitized, ambient secrets are dropped, and workspace-write routes require approval.
- OS-level sandboxing is planned, not claimed; see [SECURITY.md](SECURITY.md).
- Install script: [get.omk.dev/install.sh](https://get.omk.dev/install.sh)
- Checksums: [GitHub Releases](https://github.com/dmae97/open_multi-agent_kit/releases)
- Security policy: [SECURITY.md](SECURITY.md)

## License

[Apache-2.0](LICENSE)
