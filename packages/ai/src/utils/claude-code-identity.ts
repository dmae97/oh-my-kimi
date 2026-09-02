/**
 * Claude Code CLI identity used by the Anthropic OAuth (Pro/Max) routes.
 *
 * Anthropic gates newer models on the CLI version it parses out of the
 * user-agent. A stale value rejects the request with HTTP 400
 * `claude_code_version_too_old` ("Claude Code X does not support this model;
 * version Y or newer is required"), which fails the turn before any token is
 * produced, so this constant has to track the published Claude Code release.
 *
 * Keep it here and nowhere else: three independent copies had already drifted
 * (2.1.75 / 2.1.75 / 2.1.177) by the time the 2.1.251 model gate landed.
 *
 * Refresh with: `npm view @anthropic-ai/claude-code version`.
 */
export const CLAUDE_CODE_VERSION = "2.1.258";

/** Messages / usage API identity. */
export const CLAUDE_CODE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION}`;

/** Identity Claude Code sends when it runs as an external CLI process. */
export const CLAUDE_CODE_EXTERNAL_USER_AGENT = `${CLAUDE_CODE_CLI_USER_AGENT} (external, cli)`;

/** OAuth bootstrap identity, which uses the package name rather than the CLI name. */
export const CLAUDE_CODE_BOOTSTRAP_USER_AGENT = `claude-code/${CLAUDE_CODE_VERSION}`;
