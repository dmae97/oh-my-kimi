# Security Policy

## Reporting Vulnerabilities

Please report security issues via GitHub Issues with the `security` label.

## Built-in Protections

open_multi-agent_kit includes scoped default hooks to block destructive commands and secret leakage when the active runtime/harness enables them.

## Native Runtime Safety Gates

Canonical algorithm references: Algorithm 2 covers native turn
risk/capability routing, Algorithm 5 covers runtime fallback/authority
selection, and Algorithms 6-7 cover Kimi prompt transport and scoped worker
environments in
[`docs/native-root-runtime-algorithms.md`](./docs/native-root-runtime-algorithms.md).

- Root `omk` startup must keep MCP AutoConnect offline/read-only: it may
  summarize active MCP configs and the virtual `omk-project` mount, but it must
  not spawn stdio servers, call remote MCP endpoints, run OAuth, or prewarm
  package managers. Use explicit `omk mcp connect --all`, `omk mcp check --all`,
  or `omk mcp test <server>` for active validation.
- Native chat turns should be default-safe: read/review prompts request read-only capability, edit prompts request write/patch, and shell capability is reserved for explicit command execution under the active approval policy.
- `--execution ask|auto|never` must propagate into runtime routing and provider adapters. Do not treat `ask` as equivalent to provider-level `never`.
- Provider policies such as `authority`, `primary`, and `omk` must resolve to a concrete healthy provider before execution; unresolved authority is a hard diagnostic, not an advisory-only fallback.
- DeepSeek is read/review/advisory unless a future contract explicitly grants write/shell authority.
- CLI provider bootstrap must not treat binary existence as authentication. Provider health should distinguish runtime availability, auth/session state, selected model support, and quota/rate-limit status.
- Kimi/provider failure previews must be redacted and gated behind explicit debug mode such as `OMK_DEBUG=1`; any adapter path that still emits previews without that gate remains a release-blocking hardening gap.
- MCP, skills, and hooks parse/read failures should be visible in tool-plane diagnostics. Required runtime MCP failures should block execution rather than silently dropping all servers.

## MCP and Harness Secret Handling

- Fresh init uses project scope by default: `omk-core-verified` treats project-local `omk-project` MCP as the baseline hint, while generated `.omk/mcp.json` / `.kimi/mcp.json` may stay minimal or empty until runtime materializes managed entries. User/global MCP and skills are runtime-only unless explicitly imported by a trusted local user.
- `--local-user`, `mcp_scope = "all"`, `skills_scope = "all"`, and `hooks_scope = "all"` are trusted local-user modes, not public fresh-init defaults.
- `.kimi` is the agent-facing runtime surface for provider-specific skills, MCP, and hooks; `.omk` is OMK runtime/evidence state. Do not treat the two generated trees as interchangeable.
- Never print, commit, or summarize MCP `env`, headers, tokens, or provider keys.
- Kimi child execution and default native worker spawn paths inherit a minimal allowlist from the parent process and drop inherited secret-like keys. External CLI adapters may have adapter-specific environment contracts; explicit `env` / DAG `nodeEnv` remains trusted local input so runtime variables such as `KIMI_BIN`, `PATH`, `HOME`, and non-secret `OMK_*` values keep working. Secret-like explicit keys emit warnings. Set `OMK_STRICT_KIMI_EXPLICIT_ENV=1` to drop secret-like explicit keys unless the local trusted session also sets `OMK_TRUST_KIMI_EXPLICIT_SECRET_ENV=1`.
- `omk image generate/edit` requires an OpenAI Platform project API key supplied as an ephemeral runtime env var such as `OPENAI_API_KEY`; Codex/ChatGPT OAuth tokens are never accepted as Images API credentials.
- Isolated agent HOME shell-profile bridging is off by default because sourcing user profiles can re-export secrets; enable it only in trusted local sessions with `OMK_ISOLATED_HOME_BRIDGE_SHELL_PROFILES=1`.
- Treat `chat-agent-harness.json`, prompt envelopes, DAG node names, and run artifacts as private run metadata: use them for inventory/gates, but do not paste large inventories, prompts, or secret-like values into memory or reports.
- Prefer sanitized `omk mcp doctor --json`, `omk verify --json`, test summaries, and secret scans as shareable evidence.
- Run `npm run secret:scan:runtime` before release/demo when local `.omk` or `.kimi` trust-boundary files may contain user-added MCP wrappers or hook edits.

## Child Runtime Isolation

OMK currently provides environment hardening for child runtimes.

By default, child runtimes do not inherit the full parent process environment.
OMK passes an allowlisted environment and drops common secret-bearing variables
such as cloud provider credentials, GitHub/NPM tokens, SSH agent sockets,
Kubernetes config, and dotenv/env-file references.

This is not a full OS-level sandbox. Filesystem, process, and network isolation
are future hardening work and must not be assumed unless explicitly provided by
the selected runtime or host environment.

Current security claims:

- OMK prevents ambient secret leakage into child runtimes by default.
- OMK sanitizes child runtime environments.
- OMK routes tasks according to declared runtime capabilities.
- OMK forces approval for write-capable Codex workspace runs.
- OMK exposes sandbox intent/profile metadata for future enforcement.

Non-claims:

- OMK does not fully sandbox child CLIs.
- OMK does not prevent all filesystem access outside the workspace.
- OMK does not prevent network exfiltration.
- OMK does not enforce OS-level process isolation.

## Public Asset Provenance

- Treat `public/assets/**` as source-only reference material until license, source URL/origin, usage rights, reviewer, and review date are recorded.
- Do not move unlicensed or unprovenanced public assets into `readmeasset/`, `docs/assets/`, templates, `dist/`, or npm package contents.
- Package audit forbids `public/assets/**`; keep documentation assets in `readmeasset/` or `docs/assets/` only after provenance review.

## Best Practices

- Review hooks before running in production repositories.
- Use `--print` mode only in disposable worktrees.
- Never commit secrets into agent memory files.
