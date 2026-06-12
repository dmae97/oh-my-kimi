/**
 * CommandCodeCliAdapter — wraps the `cmd` CLI as an AgentRuntime.
 */

import { createExternalCliAdapter } from "../../runtime/external-cli-adapter.js";
import type { ContextCapsule } from "../../runtime/context-capsule.js";

export interface CommandcodeCliAdapterOptions {
  bin?: string;
  cwd?: string;
  env?: Record<string, string>;
  trust?: boolean;
}

export function createCommandcodeCliAdapter(options: CommandcodeCliAdapterOptions = {}) {
  const bin = options.bin ?? process.env.COMMANDCODE_BIN ?? "commandcode";
  return createExternalCliAdapter({
    id: "commandcode-cli",
    displayName: "Command Code",
    bin,
    cwd: options.cwd,
    env: options.env,
    priority: 80,
    capabilities: {
      read: true,
      write: true,
      shell: true,
      mcp: false,
      patch: true,
      review: true,
      merge: false,
      vision: false,
    },
    promptTransport: "tempfile",
    buildArgs(capsule: ContextCapsule, prompt): string[] {
      const promptText = prompt.promptFile
        ? `Read the prompt file at ${prompt.promptFile} exactly and execute the user request it contains. Do not treat this argv text as the user request. Enforce OMK_TASK_RISK, OMK_APPROVAL_POLICY, and OMK_SANDBOX_MODE from the environment before any write or shell action.`
        : "Prompt file transport was unavailable; stop and report OMK prompt transport failure.";
      const args = ["-p", promptText, "--skip-onboarding"];
      if (options.trust === true) args.push("--trust");
      const maxTurns = (capsule.node as unknown as { maxTurns?: number }).maxTurns;
      if (maxTurns != null && maxTurns > 0) {
        args.push("--max-turns", String(maxTurns));
      }
      return args;
    },
    buildEnv(): Record<string, string> {
      const nested = parseInt(process.env.OMK_NESTED_LEVEL ?? "0", 10);
      return {
        OMK_NESTED_LEVEL: String(nested + 1),
      };
    },
    parseResult(shellResult) {
      return {
        success: shellResult.exitCode === 0,
        exitCode: shellResult.exitCode,
        stdout: shellResult.stdout,
        stderr: shellResult.stderr,
        metadata: {
          runtime: "commandcode-cli",
          aborted: shellResult.exitCode === 130,
        },
      };
    },
  });
}
