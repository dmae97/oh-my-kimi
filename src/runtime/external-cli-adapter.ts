/**
 * ExternalCliAdapter — generic factory for AgentRuntime implementations
 * that delegate to an external CLI tool.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  AgentRunResult,
  RuntimeCapabilities,
  RuntimeHealth,
} from "./agent-runtime.js";
import type { ContextCapsule } from "./context-capsule.js";
import type { DagNodeRouting } from "../contracts/dag.js";
import type { AgentTask, AgentResult } from "./agent-runtime.js";
import {
  checkCommand,
  type ShellResult,
} from "../util/shell.js";
import { runtimeMetadataEnv } from "./child-env.js";
import { runProcessSession } from "./process-session.js";
import { createRuntimeSandboxProfile } from "./sandbox-profile.js";

export type ExternalCliPromptTransport = "argv" | "stdin" | "tempfile";

export interface ExternalCliPromptContext {
  readonly promptFile?: string;
  readonly promptEnvName: string;
}

export interface ExternalCliAdapterOptions {
  id: string;
  displayName: string;
  bin: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  priority: number;
  capabilities: RuntimeCapabilities;
  promptTransport?: ExternalCliPromptTransport;
  promptFileEnvName?: string;
  buildArgs: (
    capsule: ContextCapsule,
    promptContext: ExternalCliPromptContext
  ) => string[];
  buildInput?: (capsule: ContextCapsule) => string | undefined;
  buildEnv?: (capsule: ContextCapsule) => Record<string, string>;
  parseResult?: (
    shellResult: ShellResult,
    capsule: ContextCapsule
  ) => AgentRunResult;
}

export function createExternalCliAdapter(
  options: ExternalCliAdapterOptions
): AgentRuntime {
  let pendingOnOutput: ((text: string) => void) | undefined;

  return {
    id: options.id,
    displayName: options.displayName,
    kind: "cli",
    priority: options.priority,
    capabilities: options.capabilities,

    supports(capsule: ContextCapsule): boolean {
      return runtimeCapabilitiesSupportCapsule(options.capabilities, capsule);
    },

    async health(): Promise<RuntimeHealth> {
      const available = await checkCommand(options.bin);
      return {
        runtimeId: options.id,
        available,
        reason: available ? undefined : `Command not found: ${options.bin}`,
        checkedAt: new Date().toISOString(),
      };
    },

    async execute(task: AgentTask): Promise<AgentResult> {
      pendingOnOutput = task.context.onOutput;
      const routing = routingFromTask(task);
        const capsule: ContextCapsule = {
        schemaVersion: 1,
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
          routing,
        },
        dependencySummaries: [],
        relevantFiles: [],
        graphMemory: [],
        priorAttempts: [],
        evidenceRequirements: [],
        budget: {
          maxInputTokens: task.capabilities.maxTokens ?? 16000,
          compression: "normal",
        },
      } as unknown as ContextCapsule;
      const result = await this.runNode(capsule, task.context.abortSignal ?? new AbortController().signal);
      return {
        output: result.stdout,
        exitCode: result.exitCode ?? (result.success ? 0 : 1),
        metadata: result.metadata,
        toolCalls: result.toolCalls,
        tokenUsage: result.tokenUsage,
      };
    },

    async runNode(
      capsule: ContextCapsule,
      signal: AbortSignal
    ): Promise<AgentRunResult> {
      // Validate capsule task is not empty to prevent CLI errors
      if (!capsule.task || capsule.task.trim().length === 0) {
        const errorMsg = `Empty task for node ${capsule.nodeId}`;
        process.stderr.write(`[omk] ${errorMsg}\n`);
        return {
          success: false,
          exitCode: 1,
          stdout: `[ERROR] ${errorMsg}`,
          stderr: errorMsg,
          metadata: { ...externalCliMetadata(capsule, options.id, undefined, options.cwd), error: errorMsg },
        };
      }

      const promptEnvName = options.promptFileEnvName ?? "OMK_PROMPT_FILE";
      const promptTransport = options.promptTransport ?? "argv";
      let promptTempDir: string | undefined;
      let promptFile: string | undefined;
      const env = {
        ...runtimeMetadataEnv({
          runtimeId: options.id,
          runId: capsule.runId,
          nodeId: capsule.nodeId,
          role: capsule.node?.role,
        }),
        ...runtimeSafetyEnv(capsule),
        ...(options.env ?? {}),
        ...(options.buildEnv ? options.buildEnv(capsule) : {}),
      };
      const timeoutMs = resolveExternalCliTimeoutMs(options.timeoutMs, env.OMK_TURN_TIMEOUT_MS);

      try {
        if (promptTransport === "tempfile") {
          promptTempDir = await mkdtemp(
            join(tmpdir(), `omk-${sanitizeTempName(options.id)}-prompt-`)
          );
          promptFile = join(promptTempDir, "prompt.txt");
          await writeFile(promptFile, capsule.task, { mode: 0o600 });
          env[promptEnvName] = promptFile;
        }

        const args = options.buildArgs(capsule, {
          promptFile,
          promptEnvName,
        });
        const input =
          promptTransport === "stdin"
            ? options.buildInput?.(capsule) ?? capsule.task
            : options.buildInput?.(capsule);

        const shellResult = await runProcessSession({
          command: options.bin,
          args,
          env,
          cwd: options.cwd,
          timeoutMs,
          input,
          signal,
          onStdout: pendingOnOutput
            ? (chunk: string) => { pendingOnOutput?.(chunk); }
            : undefined,
        });

        pendingOnOutput = undefined;

        if (signal.aborted) {
          return {
            success: false,
            exitCode: 130,
            stdout: shellResult.stdout,
            stderr: "Aborted by signal",
            metadata: { ...externalCliMetadata(capsule, options.id, shellResult.durationMs, options.cwd), aborted: true },
          };
        }

        if (options.parseResult) {
          const parsed = options.parseResult(shellResult, capsule);
          return {
            ...parsed,
            metadata: {
              ...externalCliMetadata(capsule, options.id, shellResult.durationMs, options.cwd),
              ...(parsed.metadata ?? {}),
            },
          };
        }

        return {
          success: !shellResult.failed,
          exitCode: shellResult.exitCode,
          stdout: shellResult.stdout,
          stderr: shellResult.stderr,
          metadata: externalCliMetadata(capsule, options.id, shellResult.durationMs, options.cwd),
        };
      } catch (err) {
        const errorMsg = String(err);
        return {
          success: false,
          exitCode: 1,
          stdout: `[ERROR] ${errorMsg}`,
          stderr: errorMsg,
          metadata: { ...externalCliMetadata(capsule, options.id, undefined, options.cwd), error: errorMsg },
        };
      } finally {
        if (promptTempDir) {
          await rm(promptTempDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    },
  };
}

function sanitizeTempName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/giu, "_");
}

function routingFromTask(task: AgentTask): DagNodeRouting {
  const toolNames = unique(task.tools.available.map((tool) => tool.name));
  const mcpServers = unique(task.tools.mcpServers ?? []);
  const skills = unique(task.tools.skills ?? []);
  const hooks = unique(task.tools.hooks ?? []);
  return {
    risk: normalizeRisk(task.context.risk ?? task.context.env?.OMK_TASK_RISK),
    approvalPolicy: task.context.approvalPolicy ?? task.context.env?.OMK_APPROVAL_POLICY,
    sandboxMode: normalizeSandboxMode(task.context.sandboxMode ?? task.context.env?.OMK_SANDBOX_MODE),
    providerModel: task.context.providerModel ?? task.context.env?.OMK_PROVIDER_MODEL,
    assignedCapabilities: {
      tools: toolNames,
      mcpServers,
      skills,
      hooks,
    },
    tools: toolNames,
    mcpServers,
    skills,
    hooks,
  };
}

function runtimeSafetyEnv(capsule: ContextCapsule): Record<string, string | undefined> {
  const routing = capsule.node.routing;
  const assigned = routing?.assignedCapabilities;
  return {
    OMK_TASK_RISK: routing?.risk,
    OMK_APPROVAL_POLICY: routing?.approvalPolicy ?? routing?.executionPrompt,
    OMK_SANDBOX_MODE: routing?.sandboxMode,
    OMK_MCP_SERVERS: joinList(routing?.mcpServers ?? assigned?.mcpServers),
    OMK_SKILLS: joinList(routing?.skills ?? assigned?.skills),
    OMK_HOOKS: joinList(routing?.hooks ?? assigned?.hooks),
    OMK_TOOLS: joinList(routing?.tools ?? assigned?.tools),
    OMK_PROVIDER_MODEL: routing?.providerModel,
  };
}

function externalCliMetadata(
  capsule: ContextCapsule,
  runtime: string,
  durationMs?: number,
  cwd = process.cwd()
): Record<string, unknown> {
  const routing = capsule.node.routing;
  const sandboxMode = normalizeSandboxMode(routing?.sandboxMode) ?? "read-only";
  return {
    runtime,
    durationMs,
    risk: routing?.risk,
    approvalPolicy: routing?.approvalPolicy ?? routing?.executionPrompt,
    sandboxMode,
    sandboxProfile: createRuntimeSandboxProfile({
      cwd,
      mode: sandboxMode,
      enforcement: "env-only",
      writableRoots: [],
      readableRoots: [cwd],
      network: "unspecified",
      secretEnvPolicy: "drop-by-default",
      notes: [
        "External CLI env is sanitized.",
        "OS-level sandboxing is future work.",
      ],
    }),
    providerModel: routing?.providerModel,
  };
}

function normalizeRisk(value: string | undefined): DagNodeRouting["risk"] | undefined {
  return value === "read" || value === "write" || value === "shell" || value === "merge" ? value : undefined;
}

function normalizeSandboxMode(value: string | undefined): DagNodeRouting["sandboxMode"] | undefined {
  return value === "read-only" || value === "workspace-write" ? value : undefined;
}

function joinList(values: readonly string[] | undefined): string | undefined {
  const joined = unique(values ?? []).join(",");
  return joined.length > 0 ? joined : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function runtimeCapabilitiesSupportCapsule(
  capabilities: RuntimeCapabilities,
  capsule: ContextCapsule
): boolean {
  const routing = capsule.node.routing;
  if (routing?.requiresMcp === true && capabilities.mcp !== true) return false;
  if (routing?.requiresToolCalling === true && capabilities.supportsToolCalling !== true) return false;
  const required = routing?.assignedProviderCapabilities ?? [];
  for (const capability of required) {
    if (capability === "read" && capabilities.read !== true) return false;
    if (capability === "write" && capabilities.write !== true) return false;
    if (capability === "shell" && capabilities.shell !== true) return false;
    if (capability === "mcp" && capabilities.mcp !== true) return false;
    if (capability === "patch" && capabilities.patch !== true) return false;
    if (capability === "review" && capabilities.review !== true) return false;
    if (capability === "merge" && capabilities.merge !== true) return false;
    if (capability === "vision" && capabilities.vision !== true) return false;
  }
  return true;
}

function resolveExternalCliTimeoutMs(
  explicitTimeoutMs: number | undefined,
  envTimeoutMs: string | undefined
): number | undefined {
  if (explicitTimeoutMs !== undefined) return explicitTimeoutMs;
  if (!envTimeoutMs) return undefined;
  const parsed = Number.parseInt(envTimeoutMs, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
