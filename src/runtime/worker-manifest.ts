import type { DagNode } from "../contracts/dag.js";
import type {
  OmkRuntimeScope,
  TaskRunContext,
  WorkerCapabilityManifest,
  WorkerManifest,
  WorkerManifestArtifacts,
  WorkerProviderManifest,
  WorkerToolPlaneManifest,
} from "../contracts/worker-context.js";
import type { AgentTask, ProviderPolicy, ToolManifest } from "./agent-runtime.js";

export interface WorkerToolPlaneInput {
  readonly mcpServers?: readonly string[];
  readonly mcpConfigFile?: string;
  readonly skills?: readonly string[];
  readonly hooks?: readonly string[];
  readonly tools?: readonly string[];
  readonly requiresRuntimeMcp?: boolean;
}

export interface BuildTaskRunContextInput {
  readonly runId: string;
  readonly node: DagNode;
  readonly root?: string;
  readonly goalId?: string;
  readonly objective?: string;
  readonly scopes?: {
    readonly mcp?: OmkRuntimeScope;
    readonly skills?: OmkRuntimeScope;
    readonly hooks?: OmkRuntimeScope;
  };
  readonly toolPlane?: WorkerToolPlaneInput;
  readonly providerPolicy?: ProviderPolicy;
  readonly capabilities?: Partial<WorkerCapabilityManifest>;
  readonly selectedRuntimeId?: string;
  readonly model?: string;
  readonly artifacts?: WorkerManifestArtifacts;
  readonly createdAt?: string;
}

export function buildTaskRunContext(input: BuildTaskRunContextInput): TaskRunContext {
  const root = input.root ?? process.cwd();
  return {
    goal: {
      runId: input.runId,
      goalId: input.goalId,
      objective: input.objective ?? input.node.name,
      root,
      mcpScope: input.scopes?.mcp ?? "project",
      skillsScope: input.scopes?.skills ?? "project",
      hooksScope: input.scopes?.hooks ?? "project",
    },
    worker: buildWorkerManifestFromNode({ ...input, root }),
  };
}

export function buildWorkerManifestFromNode(input: BuildTaskRunContextInput): WorkerManifest {
  const toolPlane = buildWorkerToolPlane(input);
  const provider = buildWorkerProviderManifest(input);
  const derivedCapabilities = deriveWorkerCapabilities(input.node, toolPlane);
  const capabilities = normalizeWorkerCapabilities({
    ...derivedCapabilities,
    ...(input.capabilities ?? {}),
  });
  return {
    schemaVersion: 1,
    owner: "omk",
    runId: input.runId,
    nodeId: input.node.id,
    role: input.node.role,
    provider,
    toolPlane,
    capabilities,
    artifacts: input.artifacts ?? {},
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function applyTaskRunContextToAgentTask(task: AgentTask, context?: TaskRunContext): AgentTask {
  if (!context) return task;
  const manifest = context.worker;
  return {
    ...task,
    context: {
      ...task.context,
      goal: task.context.goal ?? context.goal.objective,
      goalContext: context.goal,
      workerManifest: manifest,
    },
    tools: applyWorkerToolPlane(task.tools, manifest.toolPlane),
    providerPolicy: {
      ...task.providerPolicy,
      preferredProviders: uniqueStrings([
        ...manifest.provider.preferred,
        ...task.providerPolicy.preferredProviders,
      ]),
      fallbackChain: uniqueStrings([
        ...manifest.provider.fallbackChain,
        ...task.providerPolicy.fallbackChain,
      ]),
    },
    capabilities: {
      ...task.capabilities,
      ...manifest.capabilities,
    },
  };
}

export function envFromWorkerManifest(manifest: WorkerManifest): Record<string, string> {
  const env: Record<string, string> = {
    OMK_OWNER: manifest.owner,
    OMK_WORKER_MANIFEST_OWNER: manifest.owner,
    OMK_WORKER_MANIFEST_SCHEMA: String(manifest.schemaVersion),
    OMK_WORKER_MANIFEST_RUN_ID: manifest.runId,
    OMK_WORKER_MANIFEST_NODE_ID: manifest.nodeId,
    OMK_WORKER_MANIFEST_ROLE: manifest.role ?? "",
    OMK_NODE_MCP_SERVERS: manifest.toolPlane.mcpServers.join(","),
    OMK_NODE_SKILLS: manifest.toolPlane.skills.join(","),
    OMK_NODE_HOOKS: manifest.toolPlane.hooks.join(","),
    OMK_NODE_TOOLS: manifest.toolPlane.tools.join(","),
    OMK_ROUTE_REQUIRES_MCP: String(manifest.toolPlane.requiresRuntimeMcp),
    OMK_ROUTE_REQUIRES_TOOL_CALLING: String(manifest.capabilities.toolCalling === true),
    OMK_PROVIDER_PREFERRED: manifest.provider.preferred.join(","),
    OMK_PROVIDER_FALLBACK_CHAIN: manifest.provider.fallbackChain.join(","),
  };
  if (manifest.provider.selectedRuntimeId) env.OMK_SELECTED_RUNTIME_ID = manifest.provider.selectedRuntimeId;
  if (manifest.provider.model) env.OMK_PROVIDER_MODEL = manifest.provider.model;
  if (manifest.toolPlane.mcpConfigFile) env.OMK_MCP_CONFIG_FILE = manifest.toolPlane.mcpConfigFile;
  return env;
}

function buildWorkerToolPlane(input: BuildTaskRunContextInput): WorkerToolPlaneManifest {
  const routing = input.node.routing;
  return {
    mcpServers: uniqueStrings([
      ...(input.toolPlane?.mcpServers ?? []),
      ...(routing?.mcpServers ?? []),
      ...(routing?.assignedCapabilities?.mcpServers ?? []),
    ]),
    mcpConfigFile: input.toolPlane?.mcpConfigFile,
    skills: uniqueStrings([
      ...(input.toolPlane?.skills ?? []),
      ...(routing?.skills ?? []),
      ...(routing?.assignedCapabilities?.skills ?? []),
    ]),
    hooks: uniqueStrings([
      ...(input.toolPlane?.hooks ?? []),
      ...(routing?.hooks ?? []),
      ...(routing?.assignedCapabilities?.hooks ?? []),
    ]),
    tools: uniqueStrings([
      ...(input.toolPlane?.tools ?? []),
      ...(routing?.tools ?? []),
      ...(routing?.assignedCapabilities?.tools ?? []),
    ]),
    requiresRuntimeMcp: input.toolPlane?.requiresRuntimeMcp ?? routing?.requiresMcp === true,
  };
}

function buildWorkerProviderManifest(input: BuildTaskRunContextInput): WorkerProviderManifest {
  const routing = input.node.routing;
  const provider = routing?.provider && routing.provider !== "auto" ? [routing.provider] : [];
  return {
    preferred: uniqueStrings([
      ...provider,
      ...(input.providerPolicy?.preferredProviders ?? []),
      ...(routing?.candidateProviders ?? []),
    ]),
    fallbackChain: uniqueStrings([
      ...(input.providerPolicy?.fallbackChain ?? []),
      ...(routing?.fallbackProvider ? [routing.fallbackProvider] : []),
    ]),
    selectedRuntimeId: input.selectedRuntimeId,
    model: input.model ?? routing?.providerModel,
  };
}

function deriveWorkerCapabilities(node: DagNode, toolPlane: WorkerToolPlaneManifest): WorkerCapabilityManifest {
  const routing = node.routing;
  const role = node.role?.toLowerCase() ?? "";
  const gates = node.outputs?.map((output) => output.gate).filter(Boolean) ?? [];
  const assigned = new Set(routing?.assignedProviderCapabilities ?? []);
  const readOnly = routing?.readOnly === true;
  const merge = !readOnly && (assigned.has("merge") || role === "merger" || role === "integrator" || role === "orchestrator");
  const write = !readOnly && (assigned.has("write") || merge || role === "coder" || role === "executor" || role === "refactorer");
  const shell = !readOnly && (assigned.has("shell") || routing?.requiresToolCalling === true || gates.includes("command-pass") || gates.includes("test-pass"));
  const review = assigned.has("review") || role === "reviewer" || role === "qa" || role === "tester" || gates.includes("review-pass");
  const mcp = assigned.has("mcp") || routing?.requiresMcp === true;
  const vision = assigned.has("vision");

  return {
    read: true,
    write,
    shell,
    mcp,
    patch: !readOnly && (write || assigned.has("patch")),
    review,
    merge,
    vision,
    toolCalling: routing?.requiresToolCalling === true || assigned.has("toolCalling") || toolPlane.tools.length > 0,
  };
}

function normalizeWorkerCapabilities(input: Partial<WorkerCapabilityManifest>): WorkerCapabilityManifest {
  return {
    read: input.read ?? true,
    write: input.write ?? false,
    shell: input.shell ?? false,
    mcp: input.mcp ?? false,
    patch: input.patch ?? false,
    review: input.review ?? false,
    merge: input.merge ?? false,
    vision: input.vision ?? false,
    ...(input.toolCalling !== undefined && { toolCalling: input.toolCalling }),
    ...(input.maxTokens !== undefined && { maxTokens: input.maxTokens }),
  };
}

function applyWorkerToolPlane(tools: ToolManifest, toolPlane: WorkerToolPlaneManifest): ToolManifest {
  return {
    available: mergeToolEntries(tools.available, toolPlane.tools),
    mcpServers: uniqueStrings([...(toolPlane.mcpServers ?? []), ...(tools.mcpServers ?? [])]),
    skills: uniqueStrings([...(toolPlane.skills ?? []), ...(tools.skills ?? [])]),
    hooks: uniqueStrings([...(toolPlane.hooks ?? []), ...(tools.hooks ?? [])]),
  };
}

function mergeToolEntries(
  existing: ToolManifest["available"],
  toolNames: readonly string[]
): ToolManifest["available"] {
  const seen = new Set(existing.map((tool) => tool.name));
  const merged = [...existing];
  for (const name of toolNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push({ name, description: "", inputSchema: {} });
  }
  return merged;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
