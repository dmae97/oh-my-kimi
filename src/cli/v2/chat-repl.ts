/**
 * Section 21 — Chat REPL for CLI v2
 *
 * Interactive REPL that integrates:
 * - RuntimeSidecar pipeline (debloat-nlp)
 * - CommandBus for slash commands
 * - OutputRouter for themed rendering
 * - ProviderEventNormalizer for bilingual output
 */

import { createCommandBus } from "../../runtime/command-bus.js";
import {
  classifyIntent,
  selectCapabilities,
  compileBloatToNlp,
  selectProviderRuntime,
} from "../../runtime/debloat-nlp.js";
import { createOutputRouter } from "../../runtime/output-router.js";
import type { OmkEvent, OutputProfile } from "../../runtime/contracts/command-envelope.js";

export interface ChatReplOptions {
  provider?: string;
  model?: string;
  cwd?: string;
  json?: boolean;
}

/**
 * Start an interactive chat REPL that routes all input through the full pipeline.
 */
export async function startChatRepl(options: ChatReplOptions): Promise<void> {
  const readline = await import("readline");
  const bus = createCommandBus();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: options.json ? "omk> " : "\x1b[36momk>\x1b[0m ",
  });

  const outputMode = options.json ? "json" as const : "theme" as const;
  const profile: OutputProfile = {
    format: options.json ? "json" : "nlp",
    progress: "live",
    color: "auto",
    rawProvider: false,
    explainRouting: false,
    stdoutMode: outputMode,
  };
  const router = createOutputRouter(profile);

  // Emit turn_started event
  const startEvent: OmkEvent = {
    type: "turn_started",
    data: {
      kind: "turn_started",
      intent: "chat",
      provider: options.provider || "kimi",
    },
    turnId: Date.now().toString(),
    timestamp: new Date().toISOString(),
  };
  router.route(startEvent);
  router.flush();

  console.log("Type /help for commands, /exit to quit.\n");
  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Handle exit
    if (input === "/exit" || input === "/quit") {
      const endEvent: OmkEvent = {
        type: "turn_finished",
        data: {
          kind: "turn_finished",
          durationMs: 0,
        },
        turnId: Date.now().toString(),
        timestamp: new Date().toISOString(),
      };
      router.route(endEvent);
      router.flush();
      rl.close();
      return;
    }

    // Route through CommandBus first (handles slash commands)
    const busResult = await bus.dispatch({
      kind: "chat",
      source: "cli",
      rawText: input,
    });

    if (busResult.handled) {
      for (const ev of busResult.events) {
        router.route(ev);
      }
      router.flush();
      rl.prompt();
      return;
    }

    // For regular messages: classify intent → build sidecar → render
    const intent = classifyIntent(input);
    const capabilityPlan = selectCapabilities({
      intent,
      availableMcp: [],
      availableSkills: [],
      failedMcp: [],
    });

    const result = compileBloatToNlp({
      rawText: input,
      provider: options.provider || undefined,
      model: options.model || undefined,
    });
    const sidecar = result.runtimeSidecar;

    const runtimeMode = selectProviderRuntime({
      provider: sidecar.provider || "kimi",
      intent,
    });
    const selectedMcpCount = capabilityPlan.requiredMcp.length + capabilityPlan.optionalMcp.length;
    const selectedSkillCount = capabilityPlan.selectedSkills.length;

    // Emit progress event
    const progressEvent: OmkEvent = {
      type: "progress",
      data: {
        kind: "progress",
        message: `Processing: ${intent} via ${runtimeMode} (${selectedMcpCount} MCP, ${selectedSkillCount} skills)`,
      },
      turnId: Date.now().toString(),
      timestamp: new Date().toISOString(),
    };
    router.route(progressEvent);
    router.flush();

    // In a real implementation, this would send to the provider adapter.
    // For now, emit a result event showing the pipeline worked.
    const resultEvent: OmkEvent = {
      type: "result",
      data: {
        kind: "result",
        content: `[${intent}] Pipeline processed via ${runtimeMode}. Provider adapter integration pending.`,
        format: "nlp",
      },
      turnId: Date.now().toString(),
      timestamp: new Date().toISOString(),
    };
    router.route(resultEvent);
    router.flush();

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}
