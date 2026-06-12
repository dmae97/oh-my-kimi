/**
 * Phase 1 — Plan Controller
 * Handles the 'plan' command. Adapter shell around the core planning engine.
 * Collects events via EventBus and returns a normalized CliExecutionResult.
 */

import type { CommandEnvelope, CliExecutionResult } from "./types.js";
import { createCliEventBus } from "./event-bus.js";

export async function handlePlanCommand(envelope: CommandEnvelope): Promise<CliExecutionResult> {
  const bus = createCliEventBus();

  // TODO: wire to core planning engine once available
  bus.emit({
    type: "task-started",
    taskId: envelope.runtime.runId ?? "plan-stub",
    taskTitle: envelope.input.goal ?? "plan",
    timestamp: new Date().toISOString(),
  });

  bus.emit({
    type: "task-completed",
    taskId: envelope.runtime.runId ?? "plan-stub",
    taskTitle: envelope.input.goal ?? "plan",
    timestamp: new Date().toISOString(),
  });

  return {
    command: "plan",
    success: true,
    exitCode: 0,
    result: { placeholder: true, goal: envelope.input.goal },
    events: bus.snapshot(),
  };
}
