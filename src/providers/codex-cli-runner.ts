import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { TaskResult, TaskRunner } from "../contracts/orchestration.js";
import type { DagNode } from "../orchestration/dag.js";
import { renderPromptDigest } from "../goal/prompt-digest.js";
import { runShell } from "../util/shell.js";
import { inferNodeRisk } from "./router.js";
import { buildChildEnv } from "../runtime/child-env.js";

export interface CodexCliRunnerOptions {
  bin?: string;
  cwd: string;
  model?: string;
  timeoutMs?: number;
}

export function createCodexCliAdvisoryTaskRunner(options: CodexCliRunnerOptions): TaskRunner {
  let currentOnThinking: ((thinking: string) => void) | undefined;
  const runner: TaskRunner = {
    get onThinking() {
      return currentOnThinking;
    },
    set onThinking(fn) {
      currentOnThinking = fn;
    },
    fork(onThinking) {
      const forked = createCodexCliAdvisoryTaskRunner(options);
      forked.onThinking = onThinking;
      return forked;
    },
    async run(node: DagNode, env: Record<string, string>, signal?: AbortSignal): Promise<TaskResult> {
      const risk = inferNodeRisk(node);
      const authorityMode = env.OMK_PROVIDER_AUTHORITY === "codex" || env.OMK_PROVIDER_AUTHORITY === env.OMK_PROVIDER;
      const advisoryMode = env.OMK_PROVIDER_AUTHORITY === "advisory" && risk === "write";
      if (risk !== "read" && !advisoryMode && !authorityMode) {
        return deny(node, "Codex CLI lane is read-only/advisory; write/shell/merge authority stays on the OMK authority provider");
      }
      if (!authorityMode && (node.routing?.requiresToolCalling === true || node.routing?.requiresMcp === true)) {
        return deny(node, "Codex CLI lane does not receive OMK MCP or tool authority");
      }

      currentOnThinking?.(`Codex ${authorityMode ? "authority" : "advisory"} worker: ${node.name}`);
      const tmp = await mkdtemp(join(tmpdir(), "omk-codex-provider-"));
      const outputPath = join(tmp, "last-message.txt");
      try {
        const prompt = buildCodexPrompt(node, env);
        const sandboxMode = authorityMode ? "workspace-write" : "read-only";
        const approvalPolicy = authorityMode ? "on-request" : "never";
        const childEnv = buildChildEnv({ overrideEnv: env });
        const args = [
          "exec",
          "--sandbox", sandboxMode,
          "--ask-for-approval", approvalPolicy,
          "--cd", options.cwd,
          "--color", "never",
          "--output-last-message", outputPath,
        ];
        const model = env.OMK_PROVIDER_MODEL || options.model;
        if (model && model !== "codex-cli") args.push("--model", model);
        args.push("-");
        const result = await runShell(options.bin ?? "codex", args, {
          cwd: options.cwd,
          input: prompt,
          timeout: options.timeoutMs ?? 120_000,
          signal,
          inheritEnv: false,
          env: childEnv,
        });
        const lastMessage = await readFile(outputPath, "utf-8").catch(() => "");
        return {
          success: !result.failed,
          exitCode: result.exitCode,
          stdout: lastMessage.trim() ? lastMessage : result.stdout,
          stderr: result.stderr,
        };
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
  return runner;
}

function buildCodexPrompt(node: DagNode, env: Record<string, string>): string {
  const authorityMode = env.OMK_PROVIDER_AUTHORITY === "codex" || env.OMK_PROVIDER_AUTHORITY === env.OMK_PROVIDER;
  return [
    authorityMode
      ? "You are the Codex CLI authority lane inside OMK."
      : "You are a Codex CLI advisory/read-only lane inside OMK.",
    "OMK is the root orchestrator; the configured authority provider owns final write/merge decisions.",
    authorityMode
      ? "Apply only the bounded task requested by this DAG node; do not access secrets."
      : "Do not modify files, execute writes, access secrets, or use MCP authority.",
    authorityMode
      ? "Return concise completion evidence, changed files if any, risks, and verification results."
      : "Return concise findings, evidence, risks, and recommended authority-provider follow-up.",
    "",
    `DAG node: ${node.id}`,
    `Name: ${node.name}`,
    `Role: ${node.role}`,
    `Task type: ${env.OMK_TASK_TYPE ?? "general"}`,
    `Authority: ${env.OMK_PROVIDER_AUTHORITY ?? "advisory"}`,
    renderPromptDigest("Goal context digest from OMK", env.OMK_GOAL_CONTEXT ?? env.OMK_GOAL, {
      maxKeywords: 18,
      maxPhrases: 3,
    }),
  ].join("\n");
}

function deny(node: DagNode, reason: string): TaskResult {
  return {
    success: false,
    exitCode: 1,
    stdout: "",
    stderr: `[${node.id}:${node.role}] ${reason}`,
  };
}
