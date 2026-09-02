# OMK v0.98.2

OMK v0.98.2 connects the CLI's MCP runtime, hardens verified shell execution and authentication recovery, and extends the failure-safe operation lifecycle in `omk-agent-core`. It also refreshes Claude-family compatibility and adds practical Windows, notification, and knowledge-loading extensions.

## Highlights

- **MCP tools now reach CLI sessions** — configured stdio servers attach for interactive, print, and RPC sessions, including session switches. A failed server produces a bounded startup warning without taking down servers that connected successfully; `--help` and `--list-models` never spawn servers.
- **Verified bash survives hostile dirty filenames** — workspace receipt scoping now filters dirty entries through the same normalized root-relative-path predicate used by fingerprint parsing. A malformed or Windows-UNC-like filename can no longer disable every verified bash call in a session.
- **Actionable first-run authentication** — credential-less headless runs no longer recommend the impossible command `/login unknown`; recovery points to interactive login or the provider API-key environment variable.
- **Compaction authentication recovery** — compaction asks for sufficient OAuth lifetime before starting and force-refreshes a token once when the provider rejects it before its recorded expiry, including when the compaction model differs from the session model.
- **Failure-safe harness operations** — the `omk-agent-core` lifecycle controller now owns correlated operation and attempt leases, exactly-once settlement, target-captured aborts, ordered session writes, classified flush failures, and bounded context-overflow recovery.
- **Claude-family compatibility** — Fable routes use the supported adaptive-thinking behavior, expose their high effort tiers, and share one current Claude Code client-version constant so version-gated requests do not drift across request paths.
- **Operator extensions** — added a PowerShell compatibility extension for Windows-only hosts, owner-scoped Telegram notification pairing, and an OpenKB document-to-skill integration.

## Compatibility and safety

- No public package API is intentionally removed in this patch release.
- MCP remains opt-in through `~/.omk/mcp.json` or `<workspace>/.omk/mcp.json`. Server failures are isolated, and configured environment values are never included in diagnostics.
- Verified-bash filtering changes only receipt scope metadata; rejected paths remain excluded rather than silently reinterpreted.
- Automatic and manual compaction retry a provider-rejected OAuth credential at most once.
- Existing subscription, API-key, sandbox, and extension trust boundaries remain in force.

## Verification

- Targeted coding-agent regression suites: 142 tests passed.
- Repository formatting, type, dependency-tree, import-cycle, module-size, constitution, release-consistency, documentation, private-home, release-surface, shrinkwrap, and browser-smoke gates passed before release preparation.
- The tag workflow rebuilds all packages and binaries from the tagged commit, runs `npm run check` and the full workspace test suite, then publishes all seven lockstep npm packages.

See the package changelogs for the complete change list.
