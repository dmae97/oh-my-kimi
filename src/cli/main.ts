import { Command } from "commander";
import { CliError } from "../util/cli-contract.js";
import { formatOmkVersionFooter, getOmkVersionSync } from "../util/version.js";
import { configureRootProgram, runRootOmkControlPlane } from "./root.js";
import { registerCliCommands } from "./command-registry.js";
import { createCliWriter } from "./runtime/cli-writer.js";
import {
  extractNaturalPromptInvocation,
  knownCommandNames,
} from "../ux/natural-entrypoint.js";
import type { OutputProfile } from "./runtime/types.js";

export function createOmkProgram(): Command {
  const omkVersion = getOmkVersionSync();
  const program = new Command();

  configureRootProgram(program, omkVersion, formatOmkVersionFooter(omkVersion));
  registerCliCommands(program);

  return program;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const program = createOmkProgram();
  const args = argv.slice(2);
  try {
    // When no subcommand is given, bypass Commander's default help-and-exit
    // behavior and run the root HUD flow directly.
    if (args.length === 0) {
      const globalOpts = program.opts();
      if (globalOpts.runId) {
        process.env.OMK_RUN_ID = globalOpts.runId;
      }
      await runRootOmkControlPlane(program);
      return;
    }

    if (
      args.includes("--help") ||
      args.includes("-h") ||
      args.includes("--version") ||
      args.includes("-V")
    ) {
      await program.parseAsync([...argv]);
      return;
    }

    const naturalPrompt = extractNaturalPromptInvocation(args, knownCommandNames(program));
    if (naturalPrompt) {
      const { doCommand } = await import("../commands/do.js");
      const result = await doCommand(naturalPrompt.prompt, naturalPrompt.options);
      if (!result.success && process.exitCode === undefined) {
        process.exitCode = 1;
      }
      return;
    }

    // Keep the new envelope runtime opt-in until its controllers reach parity
    // with the existing Commander workflow implementations.
    if (isCliV2Enabled()) {
      // Section 21: Route ALL commands through CLI v2 (Clipanion + RuntimeSidecar pipeline)
      const { runCliV2 } = await import("../cli/v2/cli-v2-skeleton.js");
      await runCliV2(argv);
      return;
    }


    // Fallback to existing Commander for all other commands.
    await program.parseAsync([...argv]);
  } catch (err) {
    handleCliError(err);
  }
}

function isCliV2Enabled(): boolean {
  const value = process.env.OMK_CLI_V2?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const defaultErrorProfile: OutputProfile = {
  format: "json",
  pretty: false,
  includeMessages: true,
  includeTrace: false,
  stream: false,
  destination: "stdout",
};

export function handleCliError(err: unknown, profile?: OutputProfile): void {
  const writer = createCliWriter(profile ?? defaultErrorProfile);
  if (err instanceof Error && err.name === "ExitPromptError") {
    process.exit(0);
  }
  if (err instanceof CliError) {
    if (process.exitCode === undefined) {
      process.exitCode = err.exitCode;
    }
    return;
  }
  writer.error(String(err));
  process.exit(1);
}
