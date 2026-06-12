import test from "node:test";
import assert from "node:assert/strict";

const {
  classifyKimiProviderFailure,
  classifyKimiStartupExit,
  extractKimiMcpConnectionFailureNames,
  formatKimiProviderFailureHint,
  isKimiStartupReadyData,
  resolveKimiStartupTimeoutMs,
  shouldFailOnMcpError,
} = await import("../dist/kimi/runner.js");

const monthlyQuotaError = `LLM provider error: Error code: 429 - {'error': {'message': "You've reached kimi monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle. Upgrade to get more: https://www.kimi.com/code/console?from=quota-upgrade", 'type': 'exceeded_current_quota_error'}}
If this persists, run kimi export and send the exported data to support for assistance. Please do not share the exported file publicly.`;

test("classifies Kimi monthly quota exhaustion as a provider quota failure", () => {
  const diagnosis = classifyKimiProviderFailure(monthlyQuotaError);

  assert.equal(diagnosis?.kind, "monthly-quota");
  assert.match(diagnosis?.title ?? "", /monthly quota/i);
  assert.ok(diagnosis?.remediation.some((line) => /Login\/auth can be valid/i.test(line)));
  assert.ok(diagnosis?.remediation.some((line) => /not an MCP or repository failure/i.test(line)));
  assert.ok(diagnosis?.remediation.some((line) => /kimi export/i.test(line)));
});

test("formats actionable Kimi quota guidance without echoing provider payload", () => {
  const hint = formatKimiProviderFailureHint(monthlyQuotaError);

  assert.match(hint ?? "", /Kimi monthly quota exhausted/);
  assert.match(hint ?? "", /fallback provider|non-Kimi provider/i);
  assert.match(hint ?? "", /keep the exported file private/i);
  assert.doesNotMatch(hint ?? "", /https:\/\/www\.kimi\.com\/code\/console/);
});

test("ignores unrelated runtime output", () => {
  assert.equal(classifyKimiProviderFailure("MCP server connection failed"), null);
  assert.equal(formatKimiProviderFailureHint("MCP server connection failed"), null);
  assert.equal(classifyKimiProviderFailure("Runtime note: next billing cycle starts tomorrow"), null);
  assert.equal(classifyKimiProviderFailure("MCP sync included usage limit metadata"), null);
  assert.equal(classifyKimiProviderFailure("MCP server HTTP 429 during setup"), null);
});

test("classifies optional MCP connection failures as non-fatal by requirement list", () => {
  const output = "Failed to connect MCP servers: {'omk-web-bridge': McpError('Connection closed')}";

  assert.deepEqual(extractKimiMcpConnectionFailureNames(output), ["omk-web-bridge"]);
  assert.equal(shouldFailOnMcpError({
    serverName: "omk-web-bridge",
    requiredServers: [],
    failurePolicy: "required-only",
  }), false);
  assert.equal(shouldFailOnMcpError({
    serverName: "omk-web-bridge",
    requiredServers: ["omk-web-bridge"],
    failurePolicy: "required-only",
  }), true);
  assert.equal(shouldFailOnMcpError({
    serverName: "omk-web-bridge",
    requiredServers: [],
    failurePolicy: "strict",
  }), true);
});

test("separates monthly quota exhaustion from transient rate limits", () => {
  assert.equal(classifyKimiProviderFailure("LLM provider error: Error code: 429 - rate limit exceeded")?.kind, "rate-limit");
  assert.equal(classifyKimiProviderFailure("LLM provider error: upstream unavailable")?.kind, "provider");
});

test("classifies a code-0 immediate Kimi exit as chat startup failure", () => {
  const diagnosis = classifyKimiStartupExit(0, 25, {});
  assert.match(diagnosis?.message ?? "", /exited immediately/i);
  assert.equal(classifyKimiStartupExit(0, 2500, {}), null);
  assert.equal(classifyKimiStartupExit(7, 25, {}), null);
});

test("allows fast Kimi exit when explicit escape hatch is set", () => {
  assert.equal(classifyKimiStartupExit(0, 25, { OMK_ALLOW_FAST_CHAT_EXIT: "1" }), null);
  assert.equal(classifyKimiStartupExit(0, 25, { OMK_CHAT_FAST_EXIT_MS: "0" }), null);
});

test("chat startup watchdog defaults on and ignores arbitrary noisy output", () => {
  assert.equal(resolveKimiStartupTimeoutMs({}), 45_000);
  assert.equal(resolveKimiStartupTimeoutMs({ OMK_CHAT_STARTUP_TIMEOUT_MS: "0" }), 0);
  assert.equal(resolveKimiStartupTimeoutMs({ OMK_CHAT_STARTUP_TIMEOUT_MS: "no" }), 45_000);
  assert.equal(resolveKimiStartupTimeoutMs({ OMK_CHAT_STARTUP_TIMEOUT_MS: "off" }), 45_000);
  assert.equal(resolveKimiStartupTimeoutMs({ OMK_CHAT_STARTUP_TIMEOUT_MS: "500" }), 45_000);

  assert.equal(isKimiStartupReadyData("working\n"), false);
  assert.equal(isKimiStartupReadyData(">\n"), false);
  assert.equal(isKimiStartupReadyData("›\n"), false);
  assert.equal(isKimiStartupReadyData("Kimi session: abc123\n"), true);
  assert.equal(isKimiStartupReadyData("\x1b[32mready for input\x1b[0m\n"), true);
  assert.equal(isKimiStartupReadyData("kimi❯ \n"), true);
});
