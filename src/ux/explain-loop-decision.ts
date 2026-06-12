import type { EnvMergeTraceEntry } from "../contracts/worker-context.js";
import type { LoopDecision } from "../orchestration/loop-state.js";

export function explainLoopDecision(decision: LoopDecision): string[] {
  if (decision.risk.deadlock > 0) {
    return [
      "OMK paused because pending tasks cannot run yet.",
      `Pending: ${formatList(decision.nodeSets.pending)}`,
      `Blocked: ${formatList(decision.nodeSets.blocked)}`,
      `Failed: ${formatList(decision.nodeSets.failed)}`,
      `Suggested next step: ${decision.action === "replan" ? "replan remaining work" : decision.action}`,
    ];
  }

  if (!decision.progress.madeProgress) {
    return [
      "OMK detected no progress in the last loop window.",
      "This usually means a dependency is blocked, a required artifact is missing, or approval is needed.",
      `Current action: ${decision.action}`,
      `Reason: ${decision.reason}`,
    ];
  }

  if (decision.failedNodes.length > 0 || decision.blockedNodes.length > 0) {
    return [
      "OMK found work that needs repair or replanning.",
      `Failed: ${formatList(decision.failedNodes)}`,
      `Blocked: ${formatList(decision.blockedNodes)}`,
      `Reason: ${decision.reason}`,
    ];
  }

  if (decision.action === "close") {
    return [
      "OMK is done.",
      "All required tasks and evidence gates are closed.",
    ];
  }

  return [`OMK selected action: ${decision.action}`, decision.reason];
}

export function explainEnvMergeTrace(trace: readonly EnvMergeTraceEntry[]): string[] {
  const preserved = trace.filter((entry) => entry.action === "preserve-non-empty").map((entry) => entry.key);
  const dropped = trace.filter((entry) => entry.action === "drop-empty").map((entry) => entry.key);
  const overwritten = trace.filter((entry) => entry.action === "overwrite").map((entry) => entry.key);
  const lines = ["OMK protected your runtime environment."];
  if (preserved.length > 0) lines.push(`Preserved non-empty keys: ${formatList(unique(preserved))}`);
  if (dropped.length > 0) lines.push(`Ignored empty keys: ${formatList(unique(dropped))}`);
  if (overwritten.length > 0) lines.push(`Overwritten keys: ${formatList(unique(overwritten))}`);
  if (lines.length === 1) lines.push("No suspicious env overwrite was detected.");
  return lines;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
