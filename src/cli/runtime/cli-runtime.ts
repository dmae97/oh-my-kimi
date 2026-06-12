/**
 * Phase 1 — CliRuntime
 * Central execution router. Receives a CommandEnvelope and delegates to the
 * appropriate controller based on envelope.kind.
 */

import type { CommandEnvelope, CliExecutionResult } from "./types.js";
import { handleRunCommand } from "./run-controller.js";
import { handleTaskCommand } from "./task-controller.js";
import { handlePlanCommand } from "./plan-controller.js";

export interface CliRuntime {
  execute(envelope: CommandEnvelope): Promise<CliExecutionResult>;
}

export function createCliRuntime(): CliRuntime {
  return {
    async execute(envelope: CommandEnvelope): Promise<CliExecutionResult> {
      switch (envelope.kind) {
        case "run":
          return handleRunCommand(envelope);
        case "task":
          return handleTaskCommand(envelope);
        case "plan":
          return handlePlanCommand(envelope);
        default: {
          return {
            command: envelope.kind,
            success: false,
            exitCode: 2,
            events: [],
            error: {
              kind: "usage",
              message: `Command "${envelope.kind}" is not yet implemented in the runtime bridge.`,
              hint: "Supported commands: run, task, plan",
            },
          };
        }
      }
    },
  };
}
