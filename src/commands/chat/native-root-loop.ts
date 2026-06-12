import type {
  ApprovalPolicy,
  ExecutionStrategy,
  TaskResult,
  TaskRunner,
} from "../../contracts/orchestration.js";
import type { RuntimeBootstrap } from "../../runtime/runtime-bootstrap.js";
import type { ChatLayout } from "./utils.js";
import { style } from "../../util/theme.js";
import { runShell } from "../../util/shell.js";
import { createDag, type Dag, type DagNode } from "../../orchestration/dag.js";
import {
  applyCapabilityInjectionToRouting,
  buildCapabilityInjection,
} from "../../runtime/capability-injection.js";
import {
  compileBloatToNlp,
  type DebloatRisk,
} from "../../runtime/debloat-nlp.js";
import {
  buildPromptEnvelope,
  renderPromptEnvelope,
} from "../../runtime/prompt-envelope.js";
import { buildTaskRunContext } from "../../runtime/worker-manifest.js";
import {
  buildInputEnvelope,
  normalizeMcpScope,
  type InputEnvelope,
  type InputSlashCommandEnvelope,
} from "../../input/input-envelope.js";
import { persistInputEnvelope } from "../../input/input-artifacts.js";
import { buildDagCompileResult } from "../../orchestration/dag-compiler.js";
import { persistDagCompileArtifacts } from "../../orchestration/dag-artifacts.js";
import { TerminalOwner } from "../../util/terminal-owner.js";
import type { CliRenderer } from "../../cli/ui/renderer.js";
import type { TaskRunContext } from "../../contracts/worker-context.js";
import { executeHarnessRun } from "../../harness/execute-harness-run.js";
import type { ProviderPolicy } from "../../providers/types.js";
import { buildChatTurnDag } from "./chat-turn-dag.js";
import { createSlashCommandContext } from "./slash/context.js";
import { buildNativeChatSlashCommands } from "./slash/commands/index.js";
import { parseSlashInput, type ParsedSlashInput } from "./slash/parser.js";
import { createSlashCommandRegistry } from "./slash/registry.js";
import {
  emitSlashResult,
  okSlashResult,
  printSlashResult,
} from "./slash/result.js";
import type { OmkBrandThemeName, OmkTuiMotion } from "../../brand/theme.js";
import type { TuiView } from "../../tui/model.js";
import type {
  SlashCommandContext,
  SlashCommandResult,
  SlashCommandSpec,
} from "./slash/types.js";

export interface NativeRootLoopInput {
  bootstrap: RuntimeBootstrap;
  taskRunner: TaskRunner;
  runId: string;
  root: string;
  rootSource?: string;
  activeCwd?: string;
  env: Record<string, string>;
  layout: ChatLayout;
  agentFile: string;
  mcpAllowlist?: readonly string[];
  skillNames?: readonly string[];
  hookNames?: readonly string[];
  workers?: number;
  executionPrompt?: string;
  renderer?: CliRenderer;
  onData?: (data: string) => void;
  onTodoSync?: (output: string) => void;
}

export interface NativeRootSessionState {
  bootstrap: RuntimeBootstrap;
  provider: string;
  model?: string;
  approvalPolicy?: string;
  theme?: OmkBrandThemeName;
  view?: TuiView;
  animation?: OmkTuiMotion;
  updatedAt?: string;
}

async function runSlashHandler(
  handler: SlashCommandSpec,
  parsed: ParsedSlashInput,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const result = await handler.handler(ctx, parsed.args);
  const normalized = result ?? okSlashResult();
  if (normalized.statePatch) Object.assign(ctx.state, normalized.statePatch);
  if (ctx.renderer) emitSlashResult(normalized, ctx.renderer);
  else printSlashResult(normalized);
  return normalized;
}

function isDisabledEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  );
}

export function shouldRunNativeParallelTurn(
  executionPrompt: string | undefined,
): boolean {
  return executionPrompt?.trim().toLowerCase() === "parallel";
}

async function runNativeParallelTurn(
  input: NativeRootLoopInput,
  prompt: string,
  renderer?: CliRenderer,
): Promise<number> {
  const normalizedPrompt = prompt.trim();
  const message = `\n  Spawning parallel: "${normalizedPrompt}"\n`;
  if (renderer) {
    renderer.emit({ type: "control:output", text: message });
  } else {
    console.log(style.phosphorDim(message));
  }
  const result = await runShell(
    process.execPath,
    ["dist/cli.js", "parallel", normalizedPrompt],
    {
      cwd: input.root,
      env: input.env,
      stdio: "inherit",
      timeout: 300000,
    },
  );
  if (result.failed) {
    const errorMessage = `Parallel exited with code ${result.exitCode}`;
    if (renderer) {
      renderer.emit({ type: "turn:error", message: errorMessage });
    } else {
      console.log(style.metricsRed(errorMessage));
    }
  }
  return result.exitCode ?? (result.failed ? 1 : 0);
}

function nativeApprovalPolicy(
  executionPrompt: string | undefined,
): ApprovalPolicy {
  const normalized = executionPrompt?.trim().toLowerCase();
  switch (normalized) {
    case "block":
      return "block";
    case "yolo":
      return "yolo";
    case "auto":
    case "parallel":
    case "sequential":
      return "auto";
    case "ask":
    default:
      return "interactive";
  }
}

function nativeExecutionStrategy(
  executionPrompt: string | undefined,
): ExecutionStrategy | undefined {
  const normalized = executionPrompt?.trim().toLowerCase();
  if (normalized === "sequential" || normalized === "parallel")
    return normalized;
  return undefined;
}

function bootstrapProviderPolicy(bootstrap: RuntimeBootstrap): ProviderPolicy {
  const raw = (bootstrap.providerPolicy || bootstrap.provider || "auto")
    .trim()
    .toLowerCase();
  switch (raw) {
    case "auto":
    case "authority":
    case "codex":
    case "commandcode":
    case "deepseek":
    case "kimi":
    case "local-llm":
    case "mimo":
    case "opencode":
    case "openrouter":
    case "qwen":
      return raw;
    case "local":
    case "llama":
      return "local-llm";
    default:
      return "auto";
  }
}

function emitNativeTurnRoute(input: {
  node: DagNode;
  env: Record<string, string>;
  heartbeatEnabled: boolean;
  renderer?: CliRenderer;
  mcpAllowlist?: readonly string[];
  skillNames?: readonly string[];
  hookNames?: readonly string[];
}): void {
  if (!input.heartbeatEnabled) return;
  const routing = input.node.routing;
  if (input.renderer) {
    input.renderer.emit({
      type: "turn:route",
      provider: routing?.provider ?? "auto",
      model: routing?.providerModel ?? input.env.OMK_PROVIDER_MODEL,
      risk: String(routing?.risk ?? "read"),
      sandbox: String(routing?.sandboxMode ?? "auto"),
      mcp: input.mcpAllowlist,
      skills: input.skillNames,
      hooks: input.hookNames,
    });
    return;
  }
  process.stderr.write(
    style.phosphorDim(
      `  routing: provider=${routing?.provider ?? "auto"} model=${routing?.providerModel ?? input.env.OMK_PROVIDER_MODEL ?? "auto"} risk=${routing?.risk ?? "read"} sandbox=${routing?.sandboxMode ?? "auto"}\n`,
    ),
  );
}

export function createNativeRootSessionState(input: {
  bootstrap: RuntimeBootstrap;
  executionPrompt?: string;
}): NativeRootSessionState {
  return {
    bootstrap: input.bootstrap,
    provider: input.bootstrap.provider,
    model: input.bootstrap.selectedModel,
    approvalPolicy: input.executionPrompt,
    theme: "system24",
    view: "summary",
  };
}

function buildNativeInputEnvelope(input: {
  loopInput: NativeRootLoopInput;
  state: NativeRootSessionState;
  line: string;
  parsedSlash?: ParsedSlashInput;
}): InputEnvelope {
  return buildInputEnvelope({
    runId: input.loopInput.runId,
    kind: input.parsedSlash ? "slash-command" : "plain-prompt",
    raw: input.line,
    source: "chat",
    cwd: input.loopInput.activeCwd ?? process.cwd(),
    root: input.loopInput.root,
    rootSource: input.loopInput.rootSource,
    provider: input.state.provider,
    model: input.state.model,
    mcpScope: normalizeMcpScope(input.loopInput.env.OMK_MCP_SCOPE),
    ui: input.loopInput.env.OMK_UI ?? input.loopInput.env.OMK_CHAT_UI,
    view: input.state.view ?? input.loopInput.env.OMK_TUI_VIEW,
    theme: input.state.theme,
    constraints: [],
    requestedArtifacts: [],
    slashCommand: input.parsedSlash
      ? slashCommandToEnvelope(input.parsedSlash)
      : undefined,
  });
}

function slashCommandToEnvelope(
  parsed: ParsedSlashInput,
): InputSlashCommandEnvelope {
  const flags: Record<string, boolean | string | string[]> = {};
  for (const [key, value] of Object.entries(parsed.args.flags)) {
    if (Array.isArray(value)) flags[key] = [...(value as readonly string[])];
    else if (typeof value === "boolean" || typeof value === "string")
      flags[key] = value;
  }
  return {
    command: parsed.command,
    argv: [...parsed.args.argv],
    positional: [...parsed.args.positional],
    flags,
  };
}

async function persistNativeInputEnvelope(input: {
  envelope: InputEnvelope;
  root: string;
  renderer?: CliRenderer;
}): Promise<void> {
  try {
    await persistInputEnvelope(input.envelope, { root: input.root });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const text = `InputEnvelope artifact write failed: ${message}`;
    if (input.renderer)
      input.renderer.emit({ type: "turn:error", message: text });
    else process.stderr.write(style.metricsRed(text) + "\n");
  }
}

async function persistNativeDagCompileArtifacts(input: {
  envelope: InputEnvelope;
  dag: Dag;
  root: string;
  workerCount: number;
  executionStrategy: ExecutionStrategy;
  explanation: string;
  renderer?: CliRenderer;
}): Promise<void> {
  try {
    await persistDagCompileArtifacts(
      buildDagCompileResult({
        input: input.envelope,
        dag: input.dag,
        workerCount: input.workerCount,
        executionStrategy: input.executionStrategy,
        explanation: input.explanation,
      }),
      { root: input.root },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const text = `DAG compile artifact write failed: ${message}`;
    if (input.renderer)
      input.renderer.emit({ type: "turn:error", message: text });
    else process.stderr.write(style.metricsRed(text) + "\n");
  }
}

export type NativeTurnRisk = "read" | "write" | "shell" | "merge";

const API_ADVISORY_PROVIDERS = new Set([
  "deepseek",
  "kimi",
  "local-llm",
  "mimo",
  "openrouter",
  "qwen",
]);

function hasExplicitReadOnlyIntent(text: string): boolean {
  return (
    /\b(read|inspect|look|show|list|summarize|explain|describe|review|audit|status|diagnose)\b/.test(
      text,
    ) ||
    /\b(without changing|without editing|do not change|don't change|do not edit|don't edit|no edits?|no file changes?)\b/.test(
      text,
    ) ||
    /읽기\s*전용|수정하지\s*말|변경하지\s*말|파일\s*(수정|변경)\s*(없이|하지\s*말)|요약|설명|상태|검토만|분석만|읽어|살펴/.test(
      text,
    )
  );
}

export function inferNativeTurnRisk(prompt: string): NativeTurnRisk {
  const text = prompt.toLowerCase();
  if (
    /\b(push|publish|release|merge|tag|deploy)\b|푸시|퍼블리시|릴리즈|머지|배포/.test(
      text,
    )
  )
    return "merge";
  if (
    /\b(run|test|build|exec|execute|shell|terminal|command|npm|pnpm|yarn|bun|pytest|cargo|go test|tsc|lint|verify|check)\b|테스트|빌드|실행|검증|쉘|터미널/.test(
      text,
    )
  )
    return "shell";
  if (
    /\b(fix|edit|write|implement|modify|patch|refactor|add|create|delete|update|change)\b|수정|구현|패치|리팩터|추가|삭제|변경/.test(
      text,
    )
  )
    return "write";
  if (hasExplicitReadOnlyIntent(text)) return "read";
  return "write";
}

function nativeTurnRoutingPolicy(
  provider: string,
  risk: NativeTurnRisk,
): {
  capabilities: string[];
  readOnly: boolean;
  sandboxMode: "read-only" | "workspace-write";
  providerReasonSuffix?: string;
} {
  if (isApiAdvisoryProvider(provider) && risk !== "read") {
    return {
      capabilities: ["read", "review", "advisory"],
      readOnly: true,
      sandboxMode: "read-only",
      providerReasonSuffix: `; ${provider} API is advisory/read-only for ${risk} intent; OMK owns write, shell, MCP, and merge authority`,
    };
  }
  if (risk === "read") {
    return { capabilities: ["read"], readOnly: true, sandboxMode: "read-only" };
  }
  if (risk === "write") {
    return {
      capabilities: ["write", "patch"],
      readOnly: false,
      sandboxMode: "workspace-write",
    };
  }
  if (risk === "merge") {
    return {
      capabilities: ["write", "patch", "shell", "merge"],
      readOnly: false,
      sandboxMode: "workspace-write",
    };
  }
  return {
    capabilities: ["write", "patch", "shell"],
    readOnly: false,
    sandboxMode: "workspace-write",
  };
}

function isApiAdvisoryProvider(provider: string): boolean {
  return API_ADVISORY_PROVIDERS.has(provider);
}

function debloatRiskFromNativeTurnRisk(risk: NativeTurnRisk): DebloatRisk {
  if (risk === "read") return "read";
  if (risk === "write") return "write";
  return "dangerous";
}

export function buildNativeRootLoopTurnNode(input: {
  bootstrap: RuntimeBootstrap;
  prompt: string;
  nodeId?: string;
  mcpAllowlist?: readonly string[];
  skillNames?: readonly string[];
  hookNames?: readonly string[];
  executionPrompt?: string;
}): DagNode {
  const id = input.nodeId ?? `turn-${Date.now()}`;
  const turnRisk = inferNativeTurnRisk(input.prompt);
  const routingPolicy = nativeTurnRoutingPolicy(
    input.bootstrap.provider,
    turnRisk,
  );
  const capabilityInjection = buildCapabilityInjection({
    mcpAllowlist: input.mcpAllowlist,
    skillNames: input.skillNames,
    hookNames: input.hookNames,
  });
  const envelope = buildPromptEnvelope({
    bootstrap: input.bootstrap,
    prompt: input.prompt,
    capabilities: capabilityInjection,
    role: "root-coordinator",
    nodeId: id,
    executionPrompt: input.executionPrompt,
    turnRisk,
    sandboxMode: routingPolicy.sandboxMode,
  });
  const rawEnvelope = renderPromptEnvelope(envelope);
  const compiled = compileBloatToNlp({
    rawText: rawEnvelope,
    provider: input.bootstrap.provider,
    model: input.bootstrap.selectedModel ?? "auto",
    userPayload: input.prompt,
    risk: debloatRiskFromNativeTurnRisk(turnRisk),
    sandbox: routingPolicy.sandboxMode,
    executionSelection: input.executionPrompt,
    role: "coordinator",
    evidenceRequired: false,
    capabilityEnvelope: {
      mcpEnabled: capabilityInjection.mcpServers,
      skillsEnabled: capabilityInjection.skills,
      toolsEnabled: capabilityInjection.tools.length > 0,
      liveRequired: capabilityInjection.requiresMcp,
    },
  });
  const selectedMcp = [
    ...compiled.runtimeSidecar.requiredMcp,
    ...compiled.runtimeSidecar.optionalMcp,
  ];
  const selectedCapabilityInjection = buildCapabilityInjection({
    mcpAllowlist: selectedMcp,
    skillNames: compiled.runtimeSidecar.selectedSkills,
    hookNames: input.hookNames,
    tools: capabilityInjection.tools,
    requireMcp: !isApiAdvisoryProvider(input.bootstrap.provider)
      && compiled.runtimeSidecar.requiredMcp.length > 0,
    requiresToolCalling: capabilityInjection.requiresToolCalling,
  });
  return {
    id,
    name: compiled.modelPrompt,
    role: "coordinator",
    dependsOn: [],
    status: "running",
    retries: 0,
    maxRetries: 1,
    routing: applyCapabilityInjectionToRouting(
      {
        provider: input.bootstrap.provider,
        providerModel: input.bootstrap.selectedModel,
        providerReason: `native-root-loop selected ${input.bootstrap.selectedRuntimeId ?? input.bootstrap.sessionMode}${routingPolicy.providerReasonSuffix ?? ""}`,
        assignedProviderCapabilities: routingPolicy.capabilities,
        contextBudget: "normal",
        readOnly: routingPolicy.readOnly,
        risk: turnRisk,
        promptMode: "dnc-nlp",
        runtimeSidecar: {
          ...compiled.runtimeSidecar,
          requiredMcp: [...compiled.runtimeSidecar.requiredMcp],
          optionalMcp: [...compiled.runtimeSidecar.optionalMcp],
          disabledMcp: [...compiled.runtimeSidecar.disabledMcp],
          selectedSkills: [...compiled.runtimeSidecar.selectedSkills],
        },
        executionPrompt: input.executionPrompt,
        approvalPolicy: input.executionPrompt,
        sandboxMode: routingPolicy.sandboxMode,
        rationale: `native-root-loop DNC intent=${compiled.runtimeSidecar.intent}; selected MCP=${selectedMcp.length}; selected skills=${compiled.runtimeSidecar.selectedSkills.length}; optional failures follow required-only policy`,
      },
      selectedCapabilityInjection,
    ),
  };
}

async function executeNativeRootTurn(input: {
  taskRunner: TaskRunner;
  node: DagNode;
  env: Record<string, string>;
  signal: AbortSignal;
  heartbeatEnabled: boolean;
  renderer?: CliRenderer;
  mcpAllowlist?: readonly string[];
  skillNames?: readonly string[];
  hookNames?: readonly string[];
  runContext?: TaskRunContext;
}): Promise<TaskResult> {
  const startedAt = Date.now();
  const routing = input.node.routing;
  emitNativeTurnRoute(input);

  let heartbeatPrinted = false;
  let heartbeatLineClosed = false;
  const heartbeat = input.heartbeatEnabled
    ? setInterval(() => {
        heartbeatPrinted = true;
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        if (input.renderer) {
          input.renderer.emit({
            type: "turn:heartbeat",
            elapsedMs: sec * 1000,
            provider: routing?.provider ?? "auto",
            model: routing?.providerModel ?? input.env.OMK_PROVIDER_MODEL,
          });
        } else {
          process.stderr.write(
            style.phosphorDim(
              `\r  running ${sec}s · provider=${routing?.provider ?? "auto"} · model=${routing?.providerModel ?? input.env.OMK_PROVIDER_MODEL ?? "auto"}   `,
            ),
          );
        }
      }, 3000)
    : undefined;
  heartbeat?.unref?.();

  try {
    const result = await input.taskRunner.run(
      input.node,
      input.env,
      input.signal,
      input.runContext,
    );
    if (input.heartbeatEnabled) {
      const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (input.renderer) {
        heartbeatLineClosed = true;
      } else {
        if (heartbeatPrinted) {
          process.stderr.write("\n");
          heartbeatLineClosed = true;
        }
        process.stderr.write(
          style.phosphorDim(
            `  finished in ${sec}s · exit=${result.exitCode}\n`,
          ),
        );
      }
    }
    return result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (heartbeatPrinted && !heartbeatLineClosed && !input.renderer)
      process.stderr.write("\n");
  }
}

async function buildNativeRootLoopTurnDag(input: {
  bootstrap: RuntimeBootstrap;
  prompt: string;
  mcpAllowlist?: readonly string[];
  skillNames?: readonly string[];
  hookNames?: readonly string[];
  executionPrompt?: string;
  workers?: number;
}): Promise<Dag> {
  const dag = await buildChatTurnDag({
    prompt: input.prompt,
    runId: "native-chat-turn",
    providerPolicy: bootstrapProviderPolicy(input.bootstrap),
    providerModel: input.bootstrap.selectedModel,
    workerCount: input.workers,
    executionStrategy: nativeExecutionStrategy(input.executionPrompt),
    mcpAllowlist: input.mcpAllowlist,
    skillNames: input.skillNames,
    hookNames: input.hookNames,
  });

  if (dag.nodes.length !== 1) return dag;

  const node = buildNativeRootLoopTurnNode({
    bootstrap: input.bootstrap,
    prompt: input.prompt,
    nodeId: dag.nodes[0]?.id,
    mcpAllowlist: input.mcpAllowlist,
    skillNames: input.skillNames,
    hookNames: input.hookNames,
    executionPrompt: input.executionPrompt,
  });
  return createDag({ nodes: [node] });
}

function combineNativeHarnessResults(
  success: boolean,
  completed: Array<{ node: DagNode; result: TaskResult }>,
): TaskResult {
  const last = completed.at(-1)?.result;
  const stdout = completed
    .map(({ result }) => result.stdout)
    .filter((text): text is string => Boolean(text))
    .join("\n\n");
  const stderr = completed
    .map(({ result }) => result.stderr)
    .filter((text): text is string => Boolean(text))
    .join("\n");
  return {
    success,
    exitCode: success ? 0 : (last?.exitCode ?? 1),
    stdout,
    stderr,
    metadata: {
      ...(last?.metadata ?? {}),
      harness: "dag-executor",
      completedNodes: completed.length,
    },
  };
}

async function executeNativeRootHarnessTurn(input: {
  taskRunner: TaskRunner;
  bootstrap: RuntimeBootstrap;
  prompt: string;
  runId: string;
  root: string;
  env: Record<string, string>;
  signal: AbortSignal;
  heartbeatEnabled: boolean;
  renderer?: CliRenderer;
  mcpAllowlist?: readonly string[];
  skillNames?: readonly string[];
  hookNames?: readonly string[];
  workers?: number;
  executionPrompt?: string;
  inputEnvelope?: InputEnvelope;
}): Promise<TaskResult> {
  const dag = await buildNativeRootLoopTurnDag({
    bootstrap: input.bootstrap,
    prompt: input.prompt,
    mcpAllowlist: input.mcpAllowlist,
    skillNames: input.skillNames,
    hookNames: input.hookNames,
    executionPrompt: input.executionPrompt,
    workers: input.workers,
  });
  const completed: Array<{ node: DagNode; result: TaskResult }> = [];
  const workerCount = Math.max(1, input.workers ?? 1);
  const executionStrategy =
    nativeExecutionStrategy(input.executionPrompt) ?? "sequential";

  if (input.inputEnvelope) {
    await persistNativeDagCompileArtifacts({
      envelope: input.inputEnvelope,
      dag,
      root: input.root,
      workerCount,
      executionStrategy,
      explanation: "native chat turn compiled for shared harness execution",
      renderer: input.renderer,
    });
  }

  const run = await executeHarnessRun({
    root: input.root,
    runId: input.runId,
    dag,
    runner: input.taskRunner,
    env: input.env,
    workers: workerCount,
    approvalPolicy: nativeApprovalPolicy(input.executionPrompt),
    signal: input.signal,
    onNodeStart: (node) => {
      emitNativeTurnRoute({
        node,
        env: input.env,
        heartbeatEnabled: input.heartbeatEnabled,
        renderer: input.renderer,
        mcpAllowlist: node.routing?.mcpServers ?? input.mcpAllowlist,
        skillNames: node.routing?.skills ?? input.skillNames,
        hookNames: node.routing?.hooks ?? input.hookNames,
      });
    },
    onNodeComplete: (node, result) => {
      completed.push({ node, result });
    },
  });

  const result = combineNativeHarnessResults(run.success, completed);
  result.metadata = {
    ...(result.metadata ?? {}),
    runId: run.state.runId,
    nodeCount: run.state.nodes.length,
    failedNodes: run.state.nodes.filter(
      (node) => node.status === "failed" || node.status === "blocked",
    ).length,
  };
  return result;
}

export async function runNativeOmkRootLoop(
  input: NativeRootLoopInput,
): Promise<number> {
  const { taskRunner, layout, onData } = input;
  const renderer = input.renderer;
  const turnTimeoutMs = Number.parseInt(
    input.env.OMK_TURN_TIMEOUT_MS ?? "120000",
    10,
  );
  const safeTurnTimeoutMs =
    Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0
      ? turnTimeoutMs
      : 120_000;
  const state = createNativeRootSessionState({
    bootstrap: input.bootstrap,
    executionPrompt: input.executionPrompt,
  });
  const slashRegistry = createSlashCommandRegistry(
    buildNativeChatSlashCommands(),
  );
  const slashContext = createSlashCommandContext(input, state, {
    runParallelTurn: (prompt, activeRenderer) =>
      runNativeParallelTurn(input, prompt, activeRenderer),
  });

  await renderer?.start();
  renderer?.emit({
    type: "session:start",
    runId: input.runId,
    provider: state.provider,
    model: state.model,
    layout,
    root: input.root,
    cwd: input.activeCwd,
    rootSource: input.rootSource,
  });

  // opencode-style: banner handled by PlainModernRenderer session:start event

  const { createInterface } = await import("readline");
  const rl = createInterface({
    input: process.stdin,
    output: renderer ? process.stderr : process.stdout,
  });
  const terminalOwner = new TerminalOwner(process.stdin);
  const releaseReadlineOwner = terminalOwner.claimReadline();

  let running = true;
  let readlineClosed = false;
  let activeTurnAbort: AbortController | undefined;
  const queuedLines: string[] = [];
  let pendingLineResolve: ((value: string | undefined) => void) | undefined;
  const resolveNextLine = (value: string | undefined): void => {
    const resolve = pendingLineResolve;
    pendingLineResolve = undefined;
    resolve?.(value);
  };
  rl.on("line", (line) => {
    rl.pause();
    if (pendingLineResolve) {
      resolveNextLine(line);
    } else {
      queuedLines.push(line);
    }
  });
  rl.once("close", () => {
    readlineClosed = true;
    if (queuedLines.length === 0) resolveNextLine(undefined);
  });
  const onSigint = (): void => {
    if (activeTurnAbort && !activeTurnAbort.signal.aborted) {
      activeTurnAbort.abort();
      process.stderr.write(
        style.phosphorDim("\nTurn cancelled. Press Ctrl+C again to exit.\n"),
      );
      return;
    }
    running = false;
    rl.close();
  };
  process.on("SIGINT", onSigint);

  const readPromptLine = async (): Promise<string | undefined> => {
    if (readlineClosed && queuedLines.length === 0) return undefined;
    if (renderer) {
      renderer.emit({ type: "prompt:ready" });
    } else {
      process.stdout.write(style.phosphorDim("omk> "));
    }
    const queued = queuedLines.shift();
    if (queued !== undefined) return queued;
    rl.resume();
    return new Promise<string | undefined>((resolve) => {
      pendingLineResolve = resolve;
      if (readlineClosed) resolveNextLine(undefined);
    });
  };

  while (running) {
    const userInput = await readPromptLine();
    if (userInput === undefined) break;

    const line = userInput.trim();
    if (!line) continue;
    renderer?.emit({ type: "input:submitted", text: line });

    if (["exit", "quit", ":q", "/exit", "/quit"].includes(line.toLowerCase())) {
      running = false;
      break;
    }

    const parsedSlash = parseSlashInput(line);
    const inputEnvelope = buildNativeInputEnvelope({
      loopInput: input,
      state,
      line,
      parsedSlash,
    });
    await persistNativeInputEnvelope({
      envelope: inputEnvelope,
      root: input.root,
      renderer,
    });

    if (parsedSlash) {
      const handler = slashRegistry.resolve(parsedSlash);

      if (handler) {
        try {
          await terminalOwner.withChildProcess(rl, async () => {
            const result = await runSlashHandler(
              handler,
              parsedSlash,
              slashContext,
            );
            if (result.exit) running = false;
          });
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          if (renderer) {
            renderer.emit({
              type: "turn:error",
              message: `Command error: ${m}`,
            });
          } else {
            console.error(style.metricsRed(`Command error: ${m}`));
          }
        }
        continue;
      }
      const message = `Unknown command: ${parsedSlash.command}. Type /help for commands.`;
      if (renderer) {
        renderer.emit({ type: "turn:error", message });
      } else {
        console.log(style.phosphorDim(message));
      }
      continue;
    }

    if (shouldRunNativeParallelTurn(state.approvalPolicy)) {
      const turnStartedAt = Date.now();
      try {
        const exitCode = await terminalOwner.withChildProcess(rl, () =>
          runNativeParallelTurn(input, line, renderer),
        );
        renderer?.emit({
          type: "turn:finish",
          durationMs: Date.now() - turnStartedAt,
          exitCode,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (renderer) {
          renderer.emit({ type: "turn:error", message: msg });
        } else {
          console.error(style.metricsRed(`Error: ${msg}`));
        }
      }
      continue;
    }

    const abort = new AbortController();
    activeTurnAbort = abort;
    const timeout = setTimeout(() => abort.abort(), safeTurnTimeoutMs);

    try {
      const turnStartedAt = Date.now();
      let result: TaskResult;
      if (isDisabledEnvValue(input.env.OMK_CHAT_HARNESS_TURN)) {
        const node = buildNativeRootLoopTurnNode({
          bootstrap: state.bootstrap,
          prompt: line,
          mcpAllowlist: input.mcpAllowlist,
          skillNames: input.skillNames,
          hookNames: input.hookNames,
          executionPrompt: state.approvalPolicy,
        });
        await persistNativeDagCompileArtifacts({
          envelope: inputEnvelope,
          dag: { nodes: [node] },
          root: input.root,
          workerCount: 1,
          executionStrategy:
            nativeExecutionStrategy(state.approvalPolicy) ?? "sequential",
          explanation:
            "native direct chat turn compiled to a single-node DAG artifact",
          renderer,
        });
        const turnMcpAllowlist = node.routing?.mcpServers ?? input.mcpAllowlist;
        const turnSkillNames = node.routing?.skills ?? input.skillNames;
        const turnHookNames = node.routing?.hooks ?? input.hookNames;
        const runContext = buildTaskRunContext({
          runId: input.runId,
          root: input.root,
          node,
          objective: line,
          toolPlane: {
            mcpServers: turnMcpAllowlist,
            mcpConfigFile: input.env.OMK_MCP_CONFIG_FILE,
            skills: turnSkillNames,
            hooks: turnHookNames,
            tools: node.routing?.tools,
            requiresRuntimeMcp: node.routing?.requiresMcp,
          },
          selectedRuntimeId: state.bootstrap.selectedRuntimeId,
          model: state.bootstrap.selectedModel,
        });
        result = await terminalOwner.withChildProcess(rl, () =>
          executeNativeRootTurn({
            taskRunner,
            node,
            env: input.env,
            signal: abort.signal,
            heartbeatEnabled: !isDisabledEnvValue(input.env.OMK_TURN_HEARTBEAT),
            renderer,
            mcpAllowlist: turnMcpAllowlist,
            skillNames: turnSkillNames,
            hookNames: turnHookNames,
            runContext,
          }),
        );
      } else {
        result = await terminalOwner.withChildProcess(rl, () =>
          executeNativeRootHarnessTurn({
            taskRunner,
            bootstrap: state.bootstrap,
            prompt: line,
            runId: input.runId,
            root: input.root,
            env: input.env,
            signal: abort.signal,
            heartbeatEnabled: !isDisabledEnvValue(input.env.OMK_TURN_HEARTBEAT),
            renderer,
            mcpAllowlist: input.mcpAllowlist,
            skillNames: input.skillNames,
            hookNames: input.hookNames,
            workers: input.workers,
            executionPrompt: state.approvalPolicy,
            inputEnvelope,
          }),
        );
      }

      if (result.stdout) {
        if (renderer) {
          renderer.emit({ type: "assistant:final", text: result.stdout });
        } else {
          const toolSummary =
            result.metadata?.harness === "dag-executor"
              ? `dag ${String(result.metadata.nodeCount ?? 1)} nodes`
              : "native turn";
          process.stdout.write(
            style.phosphorDim(`\n  ✓ Done · ${toolSummary}\n`),
          );
        }
        onData?.(result.stdout);
      }
      if (result.stderr && result.exitCode !== 0) {
        if (renderer) {
          renderer.emit({ type: "turn:error", message: result.stderr });
        } else {
          process.stderr.write(style.metricsRed(result.stderr) + "\n");
        }
      }
      if (!result.stdout && result.exitCode !== 0) {
        const metaError =
          result.metadata &&
          typeof result.metadata === "object" &&
          "error" in result.metadata
            ? String((result.metadata as Record<string, unknown>).error)
            : undefined;
        const message = metaError
          ? `Turn exited with code ${result.exitCode}: ${metaError}`
          : `Turn exited with code ${result.exitCode}`;
        if (renderer) {
          renderer.emit({ type: "turn:error", message });
        } else {
          process.stderr.write(style.metricsRed(message) + "\n");
        }
      }
      if (input.onTodoSync && result.stdout) {
        input.onTodoSync(result.stdout);
      }
      renderer?.emit({
        type: "turn:finish",
        durationMs: Date.now() - turnStartedAt,
        exitCode: result.exitCode ?? 0,
      });
    } catch (err) {
      const msg = abort.signal.aborted
        ? `Turn timed out after ${safeTurnTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      if (renderer) {
        renderer.emit({ type: "turn:error", message: msg });
      } else {
        console.error(style.metricsRed(`Error: ${msg}`));
      }
    } finally {
      activeTurnAbort = undefined;
      clearTimeout(timeout);
    }
  }

  process.off("SIGINT", onSigint);
  releaseReadlineOwner();
  if (!readlineClosed) rl.close();
  if (renderer) {
    renderer.emit({ type: "session:stop", exitCode: 0 });
    await renderer.stop();
  } else {
    console.log(
      style.phosphorDim(
        `\n  Session ended. Run ${style.cream("omk runs")} to see history.\n`,
      ),
    );
  }
  return 0;
}
