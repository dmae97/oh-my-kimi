import test from "node:test";
import assert from "node:assert/strict";

const { normalizeProviderTaskResult, normalizeProviderTelemetryEvent } = await import("../dist/cli/runtime/provider-event-normalizer.js");
const { renderNlp } = await import("../dist/cli/output/nlp-renderer.js");

test("normalizeProviderTaskResult converts provider metadata into normalized events", () => {
  const events = normalizeProviderTaskResult({
    taskId: "node-1",
    taskTitle: "Review plan",
    role: "reviewer",
    timestamp: "2026-05-26T00:00:00.000Z",
    durationMs: 1234,
    result: {
      success: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      metadata: {
        provider: "kimi",
        requestedProvider: "deepseek",
        providerAuthority: "authority",
        providerAttemptCount: 2,
        providerFallback: {
          from: "deepseek",
          to: "kimi",
          reason: "DeepSeek transient timeout",
          attempts: 2,
          failureKind: "transient",
        },
        providerAssist: {
          provider: "openrouter",
          participation: "advisory",
          success: true,
          model: "anthropic/claude-sonnet",
          summary: "looks safe",
        },
      },
    },
  });

  assert.deepEqual(events.map((event) => event.type), [
    "provider-request-completed",
    "provider-fallback",
    "provider-assist",
  ]);
  assert.equal(events[0].provider, "kimi");
  assert.equal(events[0].requestedProvider, "deepseek");
  assert.equal(events[0].attempts, 2);
  assert.equal(events[1].from, "deepseek");
  assert.equal(events[1].to, "kimi");
  assert.equal(events[2].provider, "openrouter");
});

test("normalizeProviderTaskResult emits provider failure and skip without raw multiline dumps", () => {
  const events = normalizeProviderTaskResult({
    taskId: "node-2",
    timestamp: "2026-05-26T00:00:00.000Z",
    result: {
      success: false,
      exitCode: 1,
      stdout: "second line should not be chosen",
      stderr: "first error line\nraw traceback line",
      metadata: {
        provider: "deepseek",
        providerSkip: {
          provider: "deepseek",
          reason: "availability failure",
          skippable: true,
          attempts: 1,
          failureKind: "availability",
        },
      },
    },
  });

  assert.deepEqual(events.map((event) => event.type), [
    "provider-request-failed",
    "provider-skip",
  ]);
  assert.equal(events[0].error, "first error line");
  assert.equal(events[1].reason, "availability failure");
});

test("normalizeProviderTelemetryEvent maps provider request lifecycle records", () => {
  const started = normalizeProviderTelemetryEvent({
    type: "provider.request.started",
    nodeId: "n1",
    provider: "kimi",
    data: { role: "coder" },
    timestamp: "2026-05-26T00:00:00.000Z",
  });
  const completed = normalizeProviderTelemetryEvent({
    type: "provider.request.completed",
    nodeId: "n1",
    provider: "kimi",
    data: { role: "coder", durationMs: 42 },
    timestamp: "2026-05-26T00:00:01.000Z",
  });

  assert.equal(started?.type, "provider-request-started");
  assert.equal(completed?.type, "provider-request-completed");
  assert.equal(completed?.durationMs, 42);
});

test("renderNlp summarizes normalized provider routing events", () => {
  const rendered = renderNlp({
    command: "run",
    success: true,
    exitCode: 0,
    result: "done",
    events: [
      {
        type: "provider-request-completed",
        provider: "kimi",
        taskId: "n1",
        timestamp: "2026-05-26T00:00:00.000Z",
      },
      {
        type: "provider-fallback",
        taskId: "n1",
        from: "deepseek",
        to: "kimi",
        reason: "timeout",
        timestamp: "2026-05-26T00:00:00.000Z",
      },
    ],
  }, {
    format: "nlp",
    pretty: false,
    includeMessages: true,
    includeTrace: false,
    stream: false,
    destination: "stdout",
  });

  assert.match(rendered.content, /Provider routing: 1 completed, 0 failed via kimi\./);
  assert.match(rendered.content, /Provider fallback: deepseek → kimi\./);
});
