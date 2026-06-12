/**
 * KimiPrintRuntime — wraps createKimiTaskRunner (kimi --print via execa).
 *
 * This is the active runtime used for DAG node execution.
 * Builds prompt from ContextCapsule and delegates to existing runner.
 */

import type { AgentRuntime, AgentRunResult, AgentTask, AgentResult } from "./agent-runtime.js";
import type { ContextCapsule } from "./context-capsule.js";
import type { DagNode } from "../orchestration/dag.js";
import { dagNodeRoutingEnv } from "../orchestration/routing.js";
import { getOmkResourceSettings } from "../util/resource-profile.js";
import { createKimiTaskRunner, type KimiTaskRunnerOptions } from "../kimi/runner.js";

export type KimiPrintRuntimeOptions = KimiTaskRunnerOptions;

export function createKimiPrintRuntime(options: KimiPrintRuntimeOptions = {}): AgentRuntime {
  let pendingOnOutput: ((text: string) => void) | undefined;

  return {
    id: "kimi-print",
    priority: 100,
    capabilities: {
      read: true,
      write: true,
      shell: true,
      mcp: true,
      patch: true,
      review: true,
      merge: false,
      vision: false,
      supportsStreaming: false,
      supportsStructuredOutput: false,
      supportsToolCalling: true,
    },

    supports(_capsule: ContextCapsule): boolean {
      return true;
    },

    async execute(task: AgentTask): Promise<AgentResult> {
      pendingOnOutput = task.context.onOutput;
      const toolNames = task.tools.available.map((tool) => tool.name);
      const capsule: ContextCapsule = {
        runId: task.context.runId,
        nodeId: task.context.nodeId,
        goal: task.context.goal ?? task.prompt,
        task: task.prompt,
        system: task.context.system ?? "",
        node: {
          id: task.context.nodeId,
          name: task.prompt,
          role: task.context.role ?? "worker",
          dependsOn: [],
          status: "running",
          retries: 0,
          maxRetries: 1,
          routing: {
            provider: "kimi",
            providerModel: task.context.providerModel ?? task.context.env?.OMK_PROVIDER_MODEL,
            readOnly: !task.capabilities.write,
            mcpServers: task.tools.mcpServers,
            skills: task.tools.skills,
            tools: toolNames,
            hooks: task.tools.hooks,
            requiresMcp: task.capabilities.mcp,
            requiresToolCalling: task.capabilities.toolCalling,
          },
        },
        dependencySummaries: [],
        relevantFiles: [],
        graphMemory: [],
        priorAttempts: [],
        evidenceRequirements: [],
        budget: {
          maxInputTokens: task.capabilities.maxTokens ?? 16000,
          reservedOutputTokens: 8192,
          maxFileTokens: 8192,
          maxToolResultTokens: 4096,
          maxMemoryFacts: 20,
          compression: "lossless-ish",
        },
      };
      const result = await this.runNode(capsule, task.context.abortSignal ?? new AbortController().signal);
      return {
        output: result.stdout,
        exitCode: result.exitCode ?? (result.success ? 0 : 1),
        metadata: result.metadata,
        tokenUsage: result.tokenUsage,
        toolCalls: result.toolCalls,
      };
    },

    async runNode(capsule: ContextCapsule, signal: AbortSignal): Promise<AgentRunResult> {
      // Validate capsule task is not empty to prevent LLM provider errors
      if (!capsule.task || capsule.task.trim().length === 0) {
        const errorMsg = `Empty task for node ${capsule.nodeId}`;
        process.stderr.write(`[omk] ${errorMsg}\n`);
        return {
          success: false,
          exitCode: 1,
          stdout: `[ERROR] ${errorMsg}`,
          stderr: errorMsg,
          metadata: { runtime: "kimi-print", error: errorMsg },
        };
      }

      const runner = createKimiTaskRunner({
        ...options,
        onOutput: pendingOnOutput,
      });

      pendingOnOutput = undefined;

      const resources = await getOmkResourceSettings();
      const env: Record<string, string> = {
        OMK_RUN_ID: capsule.runId,
        OMK_NODE_ID: capsule.nodeId,
        OMK_ROLE: capsule.node?.role ?? "",
        OMK_MCP_ENABLED: resources.mcpScope === "none" ? "false" : "true",
        OMK_SKILLS_ENABLED: resources.skillsScope === "none" ? "false" : "true",
        OMK_HOOKS_ENABLED: resources.hooksScope === "none" ? "false" : "true",
        OMK_CONTEXT_BUDGET: capsule.budget.compression,
        OMK_TOTAL_TOKENS: String(capsule.budget.maxInputTokens),
        ...(capsule.node ? dagNodeRoutingEnv(capsule.node) : {}),
      };

      const node: DagNode = {
        ...capsule.node,
        name: capsule.task,
      };

      const startedAt = Date.now();

      try {
        const result = await runner.run(node, env, signal);

        if (signal.aborted) {
          return {
            success: false,
            exitCode: 130,
            stdout: result.stdout,
            stderr: "Aborted by signal",
            metadata: { runtime: "kimi-print", aborted: true },
          };
        }

        const durationMs = Date.now() - startedAt;
        return {
          success: result.success,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          metadata: {
            runtime: "kimi-print",
            durationMs,
            ...result.metadata,
          },
        };
      } catch (err) {
        const errorMsg = String(err);
        return {
          success: false,
          exitCode: 1,
          stdout: `[ERROR] ${errorMsg}`,
          stderr: errorMsg,
          metadata: { runtime: "kimi-print", error: errorMsg },
        };
      }
    },
  };
}
