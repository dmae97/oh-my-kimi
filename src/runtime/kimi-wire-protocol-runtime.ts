/**
 * KimiWireProtocolRuntime — true wire-protocol runtime adapter.
 *
 * Communicates with Kimi CLI via `kimi --wire` using the JSON-RPC 2.0
 * wire protocol (protocol version 1.7).
 */

import type {
  AgentRuntime,
  AgentRunResult,
  AgentResult,
  AgentTask,
  RuntimeCapabilities,
  RuntimeHealth,
  ToolCallRecord,
} from "./agent-runtime.js";
import type { ContextCapsule } from "./context-capsule.js";
import { KimiWireClient } from "../adapters/kimi/wire-client.js";
import { checkCommand, resolveKimiBin } from "../util/shell.js";
import type { ToolCallEvent, ToolResultEvent } from "../adapters/kimi/wire-protocol-types.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface KimiWireProtocolRuntimeOptions {
  /** Working directory for the wire client */
  cwd?: string;
  /** Additional environment variables */
  env?: NodeJS.ProcessEnv;
  /** Agent file path */
  agentFile?: string;
  /** Config file path */
  configFile?: string;
  /** MCP config file path */
  mcpConfigFile?: string;
  /** Hook subscriptions */
  hooks?: Array<{ id: string; event: string; matcher?: string; timeout?: number }>;
}

function mapToolCallEventToRecord(tc: ToolCallEvent): ToolCallRecord {
  let input: unknown;
  if (tc.function.arguments) {
    try {
      input = JSON.parse(tc.function.arguments) as unknown;
    } catch {
      input = tc.function.arguments;
    }
  }
  return {
    name: tc.function.name,
    input,
    output: undefined,
    durationMs: 0,
    success: false,
  };
}

export class KimiWireProtocolRuntime implements AgentRuntime {
  readonly id = "kimi-wire";
  readonly kind = "cli";
  readonly priority = 85;
  readonly capabilities: RuntimeCapabilities = {
    read: true,
    write: true,
    shell: false,
    mcp: false,
    patch: true,
    review: true,
    merge: false,
    vision: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsToolCalling: true,
  };

  private readonly options: KimiWireProtocolRuntimeOptions;
  private kimiAvailable: boolean | undefined;

  constructor(options: KimiWireProtocolRuntimeOptions = {}) {
    this.options = options;
  }

  supports(capsule: ContextCapsule): boolean {
    if (this.kimiAvailable === false) return false;
    const requiresVision = capsule.node?.routing?.assignedProviderCapabilities?.includes("vision");
    if (requiresVision && !this.capabilities.vision) return false;
    const requiresToolCalling = capsule.node?.routing?.requiresToolCalling;
    if (requiresToolCalling && !this.capabilities.supportsToolCalling) return false;
    return true;
  }

  async health(): Promise<RuntimeHealth> {
    const kimiBin = resolveKimiBin();
    const available = await checkCommand(kimiBin);
    this.kimiAvailable = available;
    return {
      runtimeId: this.id,
      available,
      reason: available ? undefined : "`kimi` command not found in PATH",
      checkedAt: new Date().toISOString(),
    };
  }

  async runNode(capsule: ContextCapsule, signal: AbortSignal): Promise<AgentRunResult> {
    const client = new KimiWireClient({
      cwd: this.options.cwd,
      env: this.options.env,
      agentFile: this.options.agentFile,
      configFile: this.options.configFile,
      mcpConfigFile: this.options.mcpConfigFile,
      hooks: this.options.hooks,
    });

    try {
      await client.start();

      if (signal.aborted) {
        return {
          success: false,
          exitCode: 130,
          stdout: "",
          stderr: "Aborted before execution",
          metadata: { runtime: this.id, aborted: true },
        };
      }

      const prompt = [
        capsule.system ? `<system>\n${capsule.system}\n</system>` : "",
        capsule.task,
      ]
        .filter(Boolean)
        .join("\n\n");

      let output = "";
      let thinking = "";
      const toolCallRecords: ToolCallRecord[] = [];
      const toolResultMap = new Map<string, ToolResultEvent>();
      const toolCallIdToIndex = new Map<string, number>();
      let errorMsg = "";
      let tokenUsage: object | null = null;
      let planMode: boolean | null = null;

      const offEvent = client.onEvent((event) => {
        switch (event.type) {
          case "ContentPart": {
            if (event.payload.type === "text") {
              output += event.payload.text;
            } else if (event.payload.type === "think") {
              thinking += event.payload.think;
            }
            break;
          }
          case "TurnEnd": {
            // Turn completed
            break;
          }
          case "ToolCall": {
            toolCallIdToIndex.set(event.payload.id, toolCallRecords.length);
            toolCallRecords.push(mapToolCallEventToRecord(event.payload));
            break;
          }
          case "ToolResult": {
            toolResultMap.set(event.payload.tool_call_id, event.payload);
            const idx = toolCallIdToIndex.get(event.payload.tool_call_id);
            if (idx !== undefined) {
              toolCallRecords[idx] = {
                ...toolCallRecords[idx],
                output: event.payload.return_value.output,
                success: !event.payload.return_value.is_error,
              };
            }
            break;
          }
          case "StatusUpdate": {
            if (event.payload.token_usage) tokenUsage = event.payload.token_usage;
            if (event.payload.plan_mode != null) planMode = event.payload.plan_mode;
            break;
          }
        }
      });

      // Set up approval handler — auto-approve for now (configurable in future)
      const offApproval = client.onApprovalRequest((req, respond) => {
        respond({ request_id: req.id, response: "approve" });
      });

      const offToolCall = client.onToolCallRequest((req, respond) => {
        let isError = false;
        let toolOutput = "";
        switch (req.name) {
          case "omk_claim_task":
            // no-op: DAG node assignment — not actionable in runtime
            break;
          case "omk_update_task":
            // no-op: task status updates handled by orchestrator
            break;
          case "omk_read_memory": {
            try {
              const args = req.arguments ? JSON.parse(req.arguments) : {};
              const filePath = join(process.cwd(), ".omk", "memory", args.path);
              toolOutput = readFileSync(filePath, "utf-8");
            } catch (e) {
              isError = true;
              toolOutput = String(e);
            }
            break;
          }
          case "omk_write_memory": {
            try {
              const args = req.arguments ? JSON.parse(req.arguments) : {};
              const filePath = join(process.cwd(), ".omk", "memory", args.path);
              mkdirSync(dirname(filePath), { recursive: true });
              writeFileSync(filePath, args.content, "utf-8");
            } catch (e) {
              isError = true;
              toolOutput = String(e);
            }
            break;
          }
          case "omk_emit_metric":
            console.log(`[omk_emit_metric] ${req.arguments}`);
            break;
          case "omk_report_blocker":
            console.log(`[omk_report_blocker] ${req.arguments}`);
            break;
          default:
            isError = true;
            toolOutput = `Unknown tool: ${req.name}`;
        }
        respond({
          tool_call_id: req.id,
          return_value: { is_error: isError, output: toolOutput, message: "", display: [] },
        });
      });

      const offQuestion = client.onQuestionRequest((req, respond) => {
        respond({ request_id: req.id, answers: {} });
      });

      const offHook = client.onHookRequest((req, respond) => {
        respond({ request_id: req.id, action: "allow", reason: "" });
      });

      try {
        const result = await client.prompt(prompt);

        if (signal.aborted) {
          return {
            success: false,
            exitCode: 130,
            stdout: output,
            stderr: "Aborted during execution",
            metadata: { runtime: this.id, aborted: true },
          };
        }

        const success = result.status === "finished" || result.status === "max_steps_reached";
        return {
          success,
          exitCode: success ? 0 : 1,
          stdout: output,
          stderr: errorMsg,
          metadata: {
            runtime: this.id,
            ...(result.steps && { steps: result.steps }),
            ...(thinking && { thinking }),
            ...(tokenUsage !== null ? { tokenUsage } : {}),
            ...(planMode !== null && { planMode }),
          },
          toolCalls: toolCallRecords.length > 0 ? toolCallRecords : undefined,
        };
      } catch (err) {
        errorMsg = String(err);
        return {
          success: false,
          exitCode: 1,
          stdout: output,
          stderr: errorMsg,
          metadata: { runtime: this.id, error: errorMsg },
          toolCalls: toolCallRecords.length > 0 ? toolCallRecords : undefined,
        };
      } finally {
        offEvent();
        offApproval();
        offToolCall();
        offQuestion();
        offHook();
      }
    } finally {
      await client.stop();
    }
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const client = new KimiWireClient({
      cwd: this.options.cwd ?? task.context.cwd,
      env: {
        ...this.options.env,
        ...task.context.env,
        ...(task.context.providerModel ? { OMK_PROVIDER_MODEL: task.context.providerModel } : {}),
      },
      agentFile: this.options.agentFile,
      configFile: this.options.configFile,
      mcpConfigFile: this.options.mcpConfigFile,
      hooks: this.options.hooks,
    });

    try {
      await client.start();

      if (task.context.abortSignal?.aborted) {
        return {
          output: "",
          exitCode: 130,
          metadata: { runtime: this.id, aborted: true },
        };
      }

      let output = "";
      let thinking = "";
      const toolCallRecords: ToolCallRecord[] = [];
      const toolResultMap = new Map<string, ToolResultEvent>();
      const toolCallIdToIndex = new Map<string, number>();
      let tokenUsage: unknown = null;
      let planMode: boolean | null = null;

      const offEvent = client.onEvent((event) => {
        switch (event.type) {
          case "ContentPart": {
            if (event.payload.type === "text") {
              output += event.payload.text;
            } else if (event.payload.type === "think") {
              thinking += event.payload.think;
            }
            break;
          }
          case "TurnEnd": {
            break;
          }
          case "ToolCall": {
            toolCallIdToIndex.set(event.payload.id, toolCallRecords.length);
            toolCallRecords.push(mapToolCallEventToRecord(event.payload));
            break;
          }
          case "ToolResult": {
            toolResultMap.set(event.payload.tool_call_id, event.payload);
            const idx = toolCallIdToIndex.get(event.payload.tool_call_id);
            if (idx !== undefined) {
              toolCallRecords[idx] = {
                ...toolCallRecords[idx],
                output: event.payload.return_value.output,
                success: !event.payload.return_value.is_error,
              };
            }
            break;
          }
          case "StatusUpdate": {
            if (event.payload.token_usage) tokenUsage = event.payload.token_usage;
            if (event.payload.plan_mode != null) planMode = event.payload.plan_mode;
            break;
          }
        }
      });

      const offApproval = client.onApprovalRequest((req, respond) => {
        respond({ request_id: req.id, response: "approve" });
      });

      const offToolCall = client.onToolCallRequest((req, respond) => {
        let isError = false;
        let toolOutput = "";
        switch (req.name) {
          case "omk_claim_task":
            // no-op: DAG node assignment — not actionable in runtime
            break;
          case "omk_update_task":
            // no-op: task status updates handled by orchestrator
            break;
          case "omk_read_memory": {
            try {
              const args = req.arguments ? JSON.parse(req.arguments) : {};
              const filePath = join(process.cwd(), ".omk", "memory", args.path);
              toolOutput = readFileSync(filePath, "utf-8");
            } catch (e) {
              isError = true;
              toolOutput = String(e);
            }
            break;
          }
          case "omk_write_memory": {
            try {
              const args = req.arguments ? JSON.parse(req.arguments) : {};
              const filePath = join(process.cwd(), ".omk", "memory", args.path);
              mkdirSync(dirname(filePath), { recursive: true });
              writeFileSync(filePath, args.content, "utf-8");
            } catch (e) {
              isError = true;
              toolOutput = String(e);
            }
            break;
          }
          case "omk_emit_metric":
            console.log(`[omk_emit_metric] ${req.arguments}`);
            break;
          case "omk_report_blocker":
            console.log(`[omk_report_blocker] ${req.arguments}`);
            break;
          default:
            isError = true;
            toolOutput = `Unknown tool: ${req.name}`;
        }
        respond({
          tool_call_id: req.id,
          return_value: { is_error: isError, output: toolOutput, message: "", display: [] },
        });
      });

      const offQuestion = client.onQuestionRequest((req, respond) => {
        respond({ request_id: req.id, answers: {} });
      });

      const offHook = client.onHookRequest((req, respond) => {
        respond({ request_id: req.id, action: "allow", reason: "" });
      });

      try {
        const result = await client.prompt(task.prompt);

        if (task.context.abortSignal?.aborted) {
          return {
            output,
            exitCode: 130,
            metadata: { runtime: this.id, aborted: true },
          };
        }

        const success = result.status === "finished" || result.status === "max_steps_reached";
        return {
          output,
          exitCode: success ? 0 : 1,
          thinking: thinking || undefined,
          metadata: {
            runtime: this.id,
            ...(result.steps && { steps: result.steps }),
            ...(tokenUsage !== null ? { tokenUsage } : {}),
            ...(planMode !== null && { planMode }),
          },
          toolCalls: toolCallRecords.length > 0 ? toolCallRecords : undefined,
        };
      } catch (err) {
        return {
          output,
          exitCode: 1,
          thinking: thinking || undefined,
          metadata: { runtime: this.id, error: String(err) },
          toolCalls: toolCallRecords.length > 0 ? toolCallRecords : undefined,
        };
      } finally {
        offEvent();
        offApproval();
        offToolCall();
        offQuestion();
        offHook();
      }
    } finally {
      await client.stop();
    }
  }
}

export function createKimiWireProtocolRuntime(
  options: KimiWireProtocolRuntimeOptions = {}
): KimiWireProtocolRuntime {
  return new KimiWireProtocolRuntime(options);
}
