/**
 * Phase 1 — Task Controller
 * Handles the 'task' command. Adapter shell around the core task runner.
 * Collects events via EventBus and returns a normalized CliExecutionResult.
 */

import type { CommandEnvelope, CliExecutionResult } from "./types.js";
import { createCliEventBus } from "./event-bus.js";

export async function handleTaskCommand(envelope: CommandEnvelope): Promise<CliExecutionResult> {
  const bus = createCliEventBus();

  // TODO: wire to core task runner once available
  bus.emit({
    type: "task-started",
    taskId: envelope.runtime.runId ?? "task-stub",
    taskTitle: envelope.input.goal ?? "task",
    timestamp: new Date().toISOString(),
  });

  bus.emit({
    type: "task-completed",
    taskId: envelope.runtime.runId ?? "task-stub",
    taskTitle: envelope.input.goal ?? "task",
    timestamp: new Date().toISOString(),
  });

  return {
    command: "task",
    success: true,
    exitCode: 0,
    result: { placeholder: true, goal: envelope.input.goal },
    events: bus.snapshot(),
  };
}
