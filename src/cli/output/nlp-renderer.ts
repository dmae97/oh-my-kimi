/**
 * Deterministic NLP renderer.
 * Converts RunResult / events into human-readable natural language.
 * NO LLM calls — purely rule-based, deterministic text generation.
 */
import type {
  CliExecutionResult,
  NormalizedRunEvent,
  OutputProfile,
  RenderedOutput,
} from "../runtime/types.js";
import { hashResult } from "./hash.js";

export function renderNlp(
  result: CliExecutionResult,
  profile: OutputProfile
): RenderedOutput {
  const sentences: string[] = [];

  // Overall outcome
  const outcome = result.success ? "completed successfully" : "failed";
  sentences.push(
    `The \`${result.command}\` command ${outcome} with exit code ${result.exitCode}.`
  );

  // Agent summary
  const agentsStarted = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "agent-started" }> =>
      e.type === "agent-started"
  );
  const agentsCompleted = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "agent-completed" }> =>
      e.type === "agent-completed"
  );

  if (agentsStarted.length > 0) {
    const names = agentsStarted.map((e) => e.agentName);
    sentences.push(
      `${agentsStarted.length} agent${agentsStarted.length > 1 ? "s were" : " was"} started: ${names.join(", ")}.`
    );
  }

  const succeededAgents = agentsCompleted
    .filter((e) => e.success)
    .map((e) => e.agentName);
  const failedAgents = agentsCompleted
    .filter((e) => !e.success)
    .map((e) => e.agentName);

  if (succeededAgents.length > 0) {
    sentences.push(
      `${succeededAgents.length} agent${succeededAgents.length > 1 ? "s" : ""} finished successfully.`
    );
  }
  if (failedAgents.length > 0) {
    sentences.push(
      `${failedAgents.length} agent${failedAgents.length > 1 ? "s" : ""} encountered errors.`
    );
  }

  const providerCompletions = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "provider-request-completed" }> =>
      e.type === "provider-request-completed"
  );
  const providerFailures = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "provider-request-failed" }> =>
      e.type === "provider-request-failed"
  );
  const providerFallbacks = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "provider-fallback" }> =>
      e.type === "provider-fallback"
  );
  const providerAssists = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "provider-assist" }> =>
      e.type === "provider-assist"
  );
  const providerSkips = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "provider-skip" }> =>
      e.type === "provider-skip"
  );

  if (providerCompletions.length > 0 || providerFailures.length > 0) {
    const providers = [...new Set([...providerCompletions, ...providerFailures].map((e) => e.provider))];
    sentences.push(
      `Provider routing: ${providerCompletions.length} completed, ${providerFailures.length} failed via ${providers.join(", ")}.`
    );
  }
  if (providerFallbacks.length > 0) {
    sentences.push(
      `Provider fallback: ${providerFallbacks.map((e) => `${e.from} → ${e.to}`).join(", ")}.`
    );
  }
  if (providerAssists.length > 0) {
    sentences.push(
      `Provider advisory: ${providerAssists.length} advisory assist${providerAssists.length > 1 ? "s" : ""} recorded.`
    );
  }
  if (providerSkips.length > 0) {
    sentences.push(
      `Provider skips: ${providerSkips.map((e) => e.provider).join(", ")}.`
    );
  }

  // Task summary
  const tasksStarted = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "task-started" }> =>
      e.type === "task-started"
  );
  const tasksCompleted = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "task-completed" }> =>
      e.type === "task-completed"
  );
  const tasksFailed = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "task-failed" }> =>
      e.type === "task-failed"
  );

  if (tasksStarted.length > 0) {
    const remaining = tasksStarted.length - tasksCompleted.length - tasksFailed.length;
    sentences.push(
      `Task breakdown: ${tasksCompleted.length} completed, ${tasksFailed.length} failed${remaining > 0 ? `, ${remaining} pending` : ""}.`
    );
  }

  // Tool calls
  const toolCalls = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "tool-called" }> =>
      e.type === "tool-called"
  );
  if (toolCalls.length > 0) {
    const toolNames = [...new Set(toolCalls.map((e) => e.toolName))];
    sentences.push(
      `${toolCalls.length} tool call${toolCalls.length > 1 ? "s were" : " was"} made using ${toolNames.join(", ")}.`
    );
  }

  // Token usage
  if (result.tokenUsage) {
    const { inputTokens, outputTokens, totalTokens, model } = result.tokenUsage;
    sentences.push(
      `Token usage: ${totalTokens.toLocaleString()} total (${inputTokens.toLocaleString()} input, ${outputTokens.toLocaleString()} output)${model ? ` via ${model}` : ""}.`
    );
  }

  // Trace spans
  const traceSpans = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "trace-span" }> =>
      e.type === "trace-span"
  );
  if (traceSpans.length > 0) {
    const totalMs = traceSpans.reduce((sum, e) => sum + e.durationMs, 0);
    sentences.push(
      `Execution spanned ${traceSpans.length} trace segment${traceSpans.length > 1 ? "s" : ""} with a combined duration of ${totalMs}ms.`
    );
  }

  // Approval requests
  const approvals = result.events.filter(
    (e): e is Extract<NormalizedRunEvent, { type: "approval-requested" }> =>
      e.type === "approval-requested"
  );
  if (approvals.length > 0) {
    sentences.push(
      `${approvals.length} approval request${approvals.length > 1 ? "s were" : " was"} raised.`
    );
  }

  // Error details
  if (result.error) {
    sentences.push(`Error: ${result.error.message}`);
    if (result.error.hint) {
      sentences.push(`Hint: ${result.error.hint}`);
    }
  }

  // Optional result summary
  if (result.result !== undefined && profile.includeMessages) {
    const resultStr =
      typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result);
    const truncated =
      resultStr.length > 500 ? resultStr.slice(0, 500) + "…" : resultStr;
    sentences.push(`Result: ${truncated}`);
  }

  const content = sentences.join("\n\n");
  return {
    format: "nlp",
    content,
    sourceResultHash: hashResult(result),
    generatedAt: new Date().toISOString(),
  };
}
