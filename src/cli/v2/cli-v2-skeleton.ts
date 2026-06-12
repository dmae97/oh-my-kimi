/**
 * Section 21 — CLI v2 Full Migration
 *
 * Clipanion-based CLI with RuntimeSidecar pipeline integration.
 * All commands route through CommandBus → IntentClassifier → CapabilitySelector
 * → RuntimeSidecar → OutputRouter pipeline.
 *
 * Enabled via OMK_CLI_V2=1 environment variable.
 */

import { Cli, Command, Option } from "clipanion";
import { createCommandBus } from "../../runtime/command-bus.js";
import { classifyIntent, selectCapabilities, compileBloatToNlp, filterMcpConfigForTurn, selectProviderRuntime } from "../../runtime/debloat-nlp.js";
import { createOutputRouter } from "../../runtime/output-router.js";
import { createPersistentMemoryStore } from "./persistent-memory.js";
import { registerSlashCommands } from "../../runtime/slash-commands.js";
import { registerProviderCommandsV2 } from "./provider-commands.js";
import { registerWorkflowCommandsV2 } from "./workflow-commands.js";
import type { RequestIntent } from "../../runtime/debloat-nlp.js";
import type { OutputProfile } from "../../runtime/contracts/command-envelope.js";
/**
 * Base class for all OMK v2 commands.
 * Provides common pipeline execution helpers.
 */
export abstract class OmkCommand extends Command {
  static override usage = Command.Usage({
    description: "OMK CLI v2 command base",
  });

  cwd = Option.String("--cwd", process.cwd(), { description: "Working directory" });
  json = Option.Boolean("--json", false, { description: "JSON output" });
  theme = Option.String("--theme", "");
  provider = Option.String("--provider", "", { description: "Provider override" });
  model = Option.String("--model", "", { description: "Model override" });

  /**
   * Execute through the full RuntimeSidecar pipeline:
   * CommandBus → IntentClassifier → CapabilitySelector → RuntimeSidecar → OutputRouter
   */
  protected async executePipeline(userRequest: string, intent: string): Promise<number> {
    const bus = createCommandBus();
    registerSlashCommands(bus, {
      provider: this.provider || undefined,
      model: this.model || undefined,
      theme: this.theme || undefined,
    });
    const busResult = await bus.dispatch({ kind: "chat", source: "cli", rawText: userRequest });

    // Intent classification (map non-standard intents to valid RequestIntent)
    const classifiedIntent = classifyIntent(userRequest);
    const effectiveIntent: RequestIntent =
      (intent === "run" || intent === "model" || intent === "doctor" || intent === "theme" || intent === "memory")
        ? "chat"
        : (intent as RequestIntent) || classifiedIntent;

    // Capability selection
    const capabilityPlan = selectCapabilities({
      intent: effectiveIntent,
      availableMcp: [],
      availableSkills: [],
      failedMcp: [],
    });

    // Build RuntimeSidecar via debloated NLP compiler
    const result = compileBloatToNlp({
      rawText: userRequest,
      provider: this.provider || undefined,
      model: this.model || undefined,
    });
    const sidecar = result.runtimeSidecar;

    // Select provider runtime mode
    const runtimeMode = selectProviderRuntime({
      provider: sidecar.provider || "kimi",
      intent: effectiveIntent,
    });

    // Filter MCP config for this turn
    const mcpConfig = filterMcpConfigForTurn({
      userMcpConfig: {},
      projectMcpConfig: {},
      sidecar,
    });
    const selectedMcpCount = capabilityPlan.requiredMcp.length + capabilityPlan.optionalMcp.length;
    const selectedSkillCount = capabilityPlan.selectedSkills.length;
    const filteredMcpCount = Object.keys(mcpConfig.mcpServers).length;

    // Route output through ThemeRenderer/NlpRenderer/JsonRenderer
    const outputMode = this.json ? "json" as const : "theme" as const;
    const profile: OutputProfile = {
      format: this.json ? "json" : "nlp",
      progress: "live",
      color: "auto",
      rawProvider: false,
      explainRouting: false,
      stdoutMode: outputMode,
    };
    const router = createOutputRouter(profile);

    // Emit pipeline result as OmkEvent
    router.route({
      type: "result",
      data: {
        kind: "result",
        content: `Pipeline: ${effectiveIntent} → ${runtimeMode} (${sidecar.provider}/${sidecar.model}); capabilities=${selectedMcpCount} MCP/${selectedSkillCount} skills; mcp=${filteredMcpCount}`,
        format: "nlp",
      },
      turnId: Date.now().toString(),
      timestamp: new Date().toISOString(),
    });
    router.flush();

    // Also emit bus result events
    for (const ev of busResult.events) {
      router.route(ev);
    }
    router.flush();

    return 0;
  }
}

/**
 * `omk chat` — Interactive chat with provider
 */
export class ChatCommand extends OmkCommand {
  static override paths = [["chat"]];
  static override usage = Command.Usage({
    description: "Start interactive chat with provider",
    examples: [
      ["Start chat", "omk chat"],
      ["With message", "omk chat -m 'hello'"],
    ],
  });

  message = Option.String("-m,--message", "");

  async execute(): Promise<number> {
    if (this.message) {
      return this.executePipeline(this.message, "chat");
    }

    // Interactive REPL mode
    const { startChatRepl } = await import("./chat-repl.js");
    await startChatRepl({
      provider: this.provider,
      model: this.model,
      cwd: this.cwd,
      json: this.json,
    });
    return 0;
  }
}

/**
 * `omk run` — Execute a goal/task through the pipeline
 */
export class RunCommand extends OmkCommand {
  static override paths = [["run"]];
  static override usage = Command.Usage({
    description: "Execute a goal or task file",
    examples: [["Run a goal", "omk run goal.md"]],
  });

  goalArgs = Option.Rest();
  workers = Option.String("--workers", "");
  timeout = Option.String("--timeout", "");

  async execute(): Promise<number> {
    const userRequest = this.goalArgs.length > 0 ? this.goalArgs.join(" ") : "execute pending tasks";
    // Run pipeline classification (no stdout output)
    const classifiedIntent = classifyIntent(userRequest);
    const result = compileBloatToNlp({ rawText: userRequest });
    const sidecar = result.runtimeSidecar;
    const runtimeMode = selectProviderRuntime({ provider: sidecar.provider || "kimi", intent: classifiedIntent });
    // Output structured JSON envelope to stdout only
    this.context.stdout.write(JSON.stringify({ command: "run", result: { placeholder: true, runtimeMode } }) + "\n");
    return 0;
  }
}

/**
 * `omk status` — Show current runtime status through pipeline
 */
export class StatusCommand extends OmkCommand {
  static override paths = [["status"]];
  static override usage = Command.Usage({
    description: "Show current OMK runtime status",
  });

  async execute(): Promise<number> {
    return this.executePipeline("show current status", "status");
  }
}

/**
 * `omk model` — Show or set provider/model
 */
export class ModelCommand extends OmkCommand {
  static override paths = [["model"]];
  static override usage = Command.Usage({
    description: "Show or set current provider/model",
    examples: [
      ["Show current model", "omk model"],
      ["Set model", "omk model kimi/kimi-code"],
    ],
  });

  targetArgs = Option.Rest();

  async execute(): Promise<number> {
    const target = this.targetArgs.join(" ");
    if (target) {
      process.env.OMK_PROVIDER = target.split("/")[0] ?? "";
      process.env.OMK_MODEL = target.split("/")[1] ?? "";
      this.context.stdout.write(`Provider/model set to: ${target}\n`);
      return 0;
    }
    return this.executePipeline("show current model", "model");
  }
}

/**
 * `omk doctor` — Health check through pipeline
 */
export class DoctorCommand extends OmkCommand {
  static override paths = [["doctor"]];
  static override usage = Command.Usage({
    description: "Run OMK health checks",
  });

  async execute(): Promise<number> {
    return this.executePipeline("run health checks", "doctor");
  }
}

/**
 * `omk memory` — Project memory management
 */
export class MemoryCommand extends OmkCommand {
  static override paths = [["memory"]];
  static override usage = Command.Usage({
    description: "Manage project memory",
    examples: [
      ["Show memory", "omk memory show"],
      ["Search memory", "omk memory search 'last decision'"],
    ],
  });

  args = Option.Rest();

  async execute(): Promise<number> {
    const store = createPersistentMemoryStore({ cwd: this.cwd });
    const subcommand = this.args[0] ?? "";
    const query = this.args.slice(1).join(" ");

    switch (subcommand) {
      case "show": {
        const capsule = await store.load();
        this.context.stdout.write(JSON.stringify(capsule, null, 2) + "\n");
        return 0;
      }
      case "search": {
        if (!query) {
          this.context.stderr.write("Usage: omk memory search <query>\n");
          return 2;
        }
        const results = await store.search(query);
        this.context.stdout.write(JSON.stringify(results, null, 2) + "\n");
        return 0;
      }
      case "clear": {
        await store.clear();
        this.context.stdout.write("Memory cleared.\n");
        return 0;
      }
      default: {
        const capsule = await store.load();
        this.context.stdout.write(JSON.stringify(capsule, null, 2) + "\n");
        return 0;
      }
    }
  }
}

/**
 * `omk theme` — Show or set theme
 */
export class ThemeCommand extends OmkCommand {
  static override paths = [["theme"]];
  static override usage = Command.Usage({
    description: "Show or set CLI theme",
    examples: [
      ["Show current theme", "omk theme"],
      ["Set theme", "omk theme dark"],
    ],
  });

  nameArgs = Option.Rest();

  async execute(): Promise<number> {
    const name = this.nameArgs.join(" ");
    if (name) {
      process.env.OMK_THEME = name;
      this.context.stdout.write(`Theme set to: ${name}\n`);
    } else {
      const current = process.env.OMK_THEME ?? "omk (default)";
      this.context.stdout.write(`Current theme: ${current}\n`);
      this.context.stdout.write("Available: omk, minimal, mono, dark, light\n");
    }
    return 0;
  }
}

/**
 * Register all v2 commands on a Clipanion CLI instance.
 */
export function createCliV2() {
  const cli = new Cli({
    binaryLabel: "OMK CLI",
    binaryName: "omk",
    binaryVersion: "1.1.18",
  });

  cli.register(ChatCommand);
  cli.register(RunCommand);
  cli.register(StatusCommand);
  cli.register(ModelCommand);
  cli.register(DoctorCommand);
  cli.register(MemoryCommand);
  cli.register(ThemeCommand);

  // Section 21: Register migrated provider/model commands
  registerProviderCommandsV2(cli);

  // Section 21: Register migrated workflow commands
  registerWorkflowCommandsV2(cli);

  return cli;
}

/**
 * Run CLI v2 from argv.
 * Entry point called from main.ts when OMK_CLI_V2=1.
 */
export async function runCliV2(argv: readonly string[]): Promise<void> {
  const cli = createCliV2();
  const exitCode = await cli.run(argv.slice(2));
  process.exitCode = exitCode;
}
