/**
 * Phase 1 — Run Controller
 * Handles the 'run' command. Adapter shell around the core orchestrator.
 * Collects events via EventBus and returns a normalized CliExecutionResult.
 */

import type { CommandEnvelope, CliExecutionResult } from "./types.js";
import { createCliEventBus } from "./event-bus.js";

export async function handleRunCommand(envelope: CommandEnvelope): Promise<CliExecutionResult> {
  const bus = createCliEventBus();

  // TODO: wire to core orchestrator once available
  // For now, emit a placeholder event and return a stub result.
  bus.emit({
    type: "task-started",
    taskId: envelope.runtime.runId ?? "run-stub",
    taskTitle: envelope.input.goal ?? "run",
    timestamp: new Date().toISOString(),
  });

  bus.emit({
    type: "task-completed",
    taskId: envelope.runtime.runId ?? "run-stub",
    taskTitle: envelope.input.goal ?? "run",
    timestamp: new Date().toISOString(),
  });

  return {
    command: "run",
    success: true,
    exitCode: 0,
    result: { placeholder: true, goal: envelope.input.goal },
    events: bus.snapshot(),
  };
}
