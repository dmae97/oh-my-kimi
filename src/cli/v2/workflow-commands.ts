/**
 * Section 21 — CLI v2 Workflow Commands (Clipanion)
 *
 * Migrates Commander workflow commands (run, plan, parallel, orchestrate, etc.)
 * to Clipanion classes that delegate to existing command implementations.
 */

import { Command, Option, type Cli } from "clipanion";

type ClipanionRegistrar = Pick<Cli, "register">;

// ──────────────────────────────────────────────
// Workflow Commands
// ──────────────────────────────────────────────

export class PlanCommand extends Command {
  static override paths = [["plan"]];
  static override usage = Command.Usage({
    description: "Strategic planning with optional interview workflow",
    examples: [["Plan a feature", "omk plan 'add user authentication'"]],
  });

  goal = Option.String({ required: true });
  thinking = Option.String("--thinking", "enabled");
  specKit = Option.Boolean("--spec-kit", false);

  async execute(): Promise<number> {
    const { planCommand } = await import("../../commands/plan.js");
    await planCommand(this.goal, {
      thinking: this.thinking,
      specKit: this.specKit,
    });
    return 0;
  }
}

export class FeatureCommand extends Command {
  static override paths = [["feature"]];
  static override usage = Command.Usage({
    description: "Feature development workflow",
  });

  goal = Option.String({ required: true });
  specKit = Option.Boolean("--spec-kit", false);

  async execute(): Promise<number> {
    const { featureCommand } = await import("../../commands/workflow.js");
    await featureCommand(this.goal, { specKit: this.specKit });
    return 0;
  }
}

export class BugfixCommand extends Command {
  static override paths = [["bugfix"]];
  static override usage = Command.Usage({
    description: "Bug fix workflow",
  });

  goal = Option.String({ required: true });
  specKit = Option.Boolean("--spec-kit", false);

  async execute(): Promise<number> {
    const { bugfixCommand } = await import("../../commands/workflow.js");
    await bugfixCommand(this.goal, { specKit: this.specKit });
    return 0;
  }
}

export class RefactorCommand extends Command {
  static override paths = [["refactor"]];
  static override usage = Command.Usage({
    description: "Refactoring workflow",
  });

  goal = Option.String({ required: true });
  specKit = Option.Boolean("--spec-kit", false);

  async execute(): Promise<number> {
    const { refactorCommand } = await import("../../commands/workflow.js");
    await refactorCommand(this.goal, { specKit: this.specKit });
    return 0;
  }
}

export class ReviewCommand extends Command {
  static override paths = [["review"]];
  static override usage = Command.Usage({
    description: "Code review workflow",
  });

  ci = Option.Boolean("--ci", false);
  soft = Option.Boolean("--soft", false);

  async execute(): Promise<number> {
    const { reviewCommand } = await import("../../commands/workflow.js");
    const result = await reviewCommand({ ci: this.ci, soft: this.soft });
    if (!result && process.exitCode === undefined) {
      process.exitCode = 1;
    }
    return 0;
  }
}

export class TeamCommand extends Command {
  static override paths = [["team"]];
  static override usage = Command.Usage({
    description: "Multi-agent team workflow",
  });

  workers = Option.String("--workers", "auto");

  async execute(): Promise<number> {
    const { teamCommand } = await import("../../commands/team.js");
    await teamCommand({ workers: this.workers });
    return 0;
  }
}

export class OrchestrateCommand extends Command {
  static override paths = [["orchestrate"]];
  static override usage = Command.Usage({
    description: "Parallel agent orchestration with skill/MCP/hook assignment",
    examples: [["Orchestrate a goal", "omk orchestrate 'implement auth system'"]],
  });

  goal = Option.String({ required: true });
  workers = Option.String("--workers", "auto");
  timeout = Option.String("--timeout", "600000");
  dryRun = Option.Boolean("--dry-run", false);
  output = Option.String("--output", "");

  async execute(): Promise<number> {
    const { orchestrateCommand } = await import("../../commands/orchestrate.js");
    const result = await orchestrateCommand(this.goal, {
      workers: this.workers,
      timeout: this.timeout,
      dryRun: this.dryRun,
      output: this.output || undefined,
    });
    if (result && !result.success && process.exitCode === undefined) {
      process.exitCode = 1;
    }
    return 0;
  }
}

// ──────────────────────────────────────────────
// Consent Command
// ──────────────────────────────────────────────

export class ConsentCommand extends Command {
  static override paths = [["consent"]];
  static override usage = Command.Usage({
    description: "Manage data sharing consent levels (L0-L4)",
    examples: [
      ["Show status", "omk consent status"],
      ["Enable level", "omk consent enable l1"],
      ["Preview data", "omk consent preview"],
      ["Revoke all", "omk consent revoke"],
    ],
  });

  subcommand = Option.String({ required: true });
  level = Option.String("");

  async execute(): Promise<number> {
    const consent = await import("../../commands/consent.js");

    switch (this.subcommand) {
      case "status":
        consent.consentStatus();
        break;
      case "enable": {
        if (!this.level) {
          this.context.stderr.write("Usage: omk consent enable <level>\n");
          return 2;
        }
        const lv = this.level.toLowerCase();
        if (!["l0", "l1", "l2", "l3"].includes(lv)) {
          this.context.stderr.write(`Invalid level: ${this.level}. Use l0, l1, l2, or l3.` + "\n");
          return 1;
        }
        consent.consentEnable(lv as "l0" | "l1" | "l2" | "l3");
        break;
      }
      case "disable": {
        if (!this.level) {
          this.context.stderr.write("Usage: omk consent disable <level>\n");
          return 2;
        }
        const lv = this.level.toLowerCase();
        if (!["l0", "l1", "l2", "l3"].includes(lv)) {
          this.context.stderr.write(`Invalid level: ${this.level}. Use l0, l1, l2, or l3.` + "\n");
          return 1;
        }
        consent.consentDisable(lv as "l0" | "l1" | "l2" | "l3");
        break;
      }
      case "preview":
        consent.consentPreview();
        break;
      case "export":
        consent.consentExport();
        break;
      case "revoke":
        consent.consentRevoke();
        break;
      default:
        this.context.stderr.write(`Unknown consent subcommand: ${this.subcommand}` + "\n");
        this.context.stderr.write("Valid: status, enable, disable, preview, export, revoke\n");
        return 2;
    }
    return 0;
  }
}

/**
 * Register all workflow commands on a Clipanion CLI instance.
 */
export function registerWorkflowCommandsV2(cli: ClipanionRegistrar): void {
  cli.register(PlanCommand);
  cli.register(FeatureCommand);
  cli.register(BugfixCommand);
  cli.register(RefactorCommand);
  cli.register(ReviewCommand);
  cli.register(TeamCommand);
  cli.register(OrchestrateCommand);
  cli.register(ConsentCommand);
}
