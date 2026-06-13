# OMK

Project-aware AI coding runtime.

Current source version: `open-multi-agent-kit@0.78.8`.

Install once. Resume every project. Route to the best coding model.

## Install

```bash
npm install -g open-multi-agent-kit
```

For local verification from a checkout:

```bash
npm ci
npm run build
node dist/cli.js do "explain this repo" --dry-run --json
npm run verify:no-kimi
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
omk doctor        # verify local setup
omk chat          # start coding
omk consent       # privacy settings
```

## Security

- Safe by default: child env is sanitized, ambient secrets are dropped, and workspace-write routes require approval.
- OS-level sandboxing is planned, not claimed; see [SECURITY.md](SECURITY.md).
- registry verification: confirm the npm package metadata and GitHub release checksum before promotion.
- Checksums: [GitHub Releases](https://github.com/dmae97/open-multi-agent-kit/releases)
- Security policy: [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
