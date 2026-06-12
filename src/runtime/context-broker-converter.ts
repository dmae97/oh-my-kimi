import type { ContextCapsule } from "./context-capsule.js";
import type {
  AgentTask,
  AgentContext,
  ToolManifest,
  ProviderPolicy,
  CapabilityManifest,
} from "./agent-runtime.js";

export async function capsuleToTask(
  capsule: ContextCapsule,
  options: AbortSignal | CapsuleToTaskOptions = {}
): Promise<AgentTask> {
  const taskOptions: CapsuleToTaskOptions = isAbortSignal(options)
    ? { signal: options }
    : options;
  const node = capsule.node;
  const routing = node.routing;

  const context: AgentContext = {
    runId: capsule.runId,
    nodeId: capsule.nodeId,
    role: node.role,
    goal: capsule.goal,
    system: capsule.system,
    files: capsule.relevantFiles.map((f) => f.path),
    memory: capsule.graphMemory.map((m) => ({
      key: m.key,
      source: m.kind,
      summary: m.value,
    })),
    abortSignal: taskOptions.signal,
    cwd: taskOptions.cwd,
    env: taskOptions.env,
    providerModel: routing?.providerModel,
    risk: routing?.risk,
    approvalPolicy: routing?.approvalPolicy ?? routing?.executionPrompt,
    sandboxMode: routing?.sandboxMode,
  };

  const toolNames =
    routing?.tools ?? routing?.assignedCapabilities?.tools ?? [];
  const mcpServers = routing?.mcpServers ?? routing?.assignedCapabilities?.mcpServers ?? [];
  const skills = routing?.skills ?? routing?.assignedCapabilities?.skills ?? [];
  const hooks = routing?.hooks ?? routing?.assignedCapabilities?.hooks ?? [];
  const tools: ToolManifest = {
    available: toolNames.map((name) => ({
      name,
      description: "",
      inputSchema: {},
    })),
    mcpServers,
    skills,
    hooks,
  };

  const preferredProviders: string[] = [];
  if (routing?.provider && routing.provider !== "auto") {
    preferredProviders.push(routing.provider);
  }
  if (routing?.candidateProviders?.length) {
    preferredProviders.push(...routing.candidateProviders);
  }

  const fallbackChain: string[] = [...(taskOptions.fallbackChain ?? [])];
  if (routing?.fallbackProvider && !fallbackChain.includes(routing.fallbackProvider)) {
    fallbackChain.push(routing.fallbackProvider);
  }

  const providerPolicy: ProviderPolicy = {
    strategy: "priority-first",
    preferredProviders,
    fallbackChain,
    maxCost: undefined,
    maxLatencyMs: undefined,
  };

  const capabilities = capabilitiesFromNode(capsule);

  const task: AgentTask = {
    prompt: capsule.task,
    context,
    tools,
    providerPolicy,
    capabilities,
  };

  return task;
}

export interface CapsuleToTaskOptions {
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly fallbackChain?: readonly string[];
}

function isAbortSignal(value: AbortSignal | CapsuleToTaskOptions): value is AbortSignal {
  return "aborted" in value && typeof value.addEventListener === "function";
}

function capabilitiesFromNode(capsule: ContextCapsule): CapabilityManifest {
  const node = capsule.node;
  const routing = node.routing;
  const role = node.role?.toLowerCase() ?? "";
  const gates = node.outputs?.map((output) => output.gate).filter(Boolean) ?? [];
  const assigned = new Set(routing?.assignedProviderCapabilities ?? []);
  const merge = assigned.has("merge") || role === "merger" || role === "integrator" || role === "orchestrator";
  const write = assigned.has("write") || merge || role === "coder" || role === "executor" || role === "refactorer";
  const shell = assigned.has("shell") || routing?.requiresToolCalling === true || gates.includes("command-pass") || gates.includes("test-pass");
  const review = assigned.has("review") || role === "reviewer" || role === "qa" || role === "tester" || gates.includes("review-pass");
  const mcp = assigned.has("mcp") || routing?.requiresMcp === true;
  const vision = assigned.has("vision");

  return {
    read: true,
    write: routing?.readOnly === true ? false : write,
    shell,
    mcp,
    patch: routing?.readOnly === true ? false : write,
    review,
    merge,
    vision,
    toolCalling: routing?.requiresToolCalling === true || assigned.has("toolCalling"),
    maxTokens: capsule.budget.maxInputTokens,
  };
}
