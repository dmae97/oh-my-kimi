import type { DagContextBudget, DagNode, DagNodeDefinition, DagNodeRouting } from "./dag.js";
import { attachAssignedCapabilities, capabilityScopesFromRouting } from "./capability-routing.js";
import { discoverRoutingInventory, routeCandidates } from "./routing/inventory.js";
import type { RouteCandidate, RoutingInventory, ScoredRoute } from "./routing/types.js";
import { assignSkills } from "./skill-assigner.js";
import { DEFAULT_AUTHORITY_PROVIDER, resolveFallbackProvider } from "../providers/types.js";
import {
  OMK_RELEASE_GUARD_PRESET,
  OMK_TS_PRODUCT_PRESET,
  OMK_WORKTREE_TEAM_PRESET,
} from "../runtime/core-verified-preset.js";

export {
  discoverRoutingInventory,
  resetRoutingInventoryCache,
} from "./routing/inventory.js";

export type RoutingInput = Pick<DagNodeDefinition, "id" | "name" | "role" | "inputs" | "outputs" | "cost" | "routing">;

const MAX_SKILLS = 3;
const MAX_MCP_SERVERS = 2;
const MAX_TOOLS = 4;
const MAX_HOOKS = 4;
const ROUTE_CANDIDATES: RouteCandidate[] = [
  {
    kind: "skill",
    id: "omk-repo-explorer",
    source: "project",
    roles: ["explorer", "researcher", "architect", "planner"],
    keywords: ["repo", "repository", "file", "symbol", "grep", "search", "map", "inspect", "discover", "코드", "검색", "탐색"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 1,
    capabilities: ["repo-map", "symbol-search", "small-context"],
  },
  {
    kind: "skill",
    id: "omk-industrial-control-loop",
    source: "project",
    roles: ["planner", "architect", "orchestrator", "router"],
    keywords: ["dag", "dependency", "graph", "workflow", "orchestration", "scheduler", "agent", "앙상블", "에이전트"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["dag-design", "dependency-check", "quality-gate-shape"],
  },
  {
    kind: "skill",
    id: "omk-quality-gate",
    source: "project",
    roles: ["qa", "reviewer", "verifier", "tester"],
    keywords: ["quality", "gate", "test", "lint", "build", "typecheck", "verify", "검증", "테스트"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 1,
    capabilities: ["verification", "test-command-selection"],
  },
  {
    kind: "skill",
    id: "omk-test-debug-loop",
    source: "project",
    roles: ["debugger", "tester", "coder"],
    keywords: ["bug", "error", "failure", "regression", "debug", "fix", "버그", "오류", "실패"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 2,
    capabilities: ["debug-loop", "regression-tests"],
  },
  {
    kind: "skill",
    id: "omk-code-review",
    source: "project",
    roles: ["reviewer", "architect", "verifier"],
    keywords: ["review", "audit", "risk", "maintainability", "품질", "리뷰"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["code-review", "risk-check"],
  },
  {
    kind: "skill",
    id: "omk-security-review",
    source: "project",
    roles: ["security", "reviewer"],
    keywords: ["security", "secret", "auth", "permission", "token", "credential", "보안", "시크릿"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["security-review", "trust-boundary"],
  },
  {
    kind: "skill",
    id: "omk-secret-guard",
    source: "project",
    roles: ["security", "reviewer"],
    keywords: ["secret", "token", "credential", "env", "api key", "시크릿", "키"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["secret-hygiene"],
  },
  {
    kind: "skill",
    id: "omk-research-verify",
    source: "project",
    roles: ["researcher", "architect", "planner"],
    keywords: ["paper", "docs", "official", "current", "api", "research", "논문", "문서", "공식"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 2,
    capabilities: ["official-docs", "citation-backed"],
  },
  {
    kind: "skill",
    id: "omk-context-broker",
    source: "project",
    roles: ["router", "planner", "architect"],
    keywords: ["context", "memory", "handoff", "checkpoint", "small context", "컨텍스트", "메모리"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["context-pruning", "handoff"],
  },
  {
    kind: "skill",
    id: "omk-typescript-strict",
    source: "project",
    roles: ["coder", "reviewer"],
    keywords: ["typescript", "ts", "type", "strict", "타입"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 1,
    capabilities: ["typescript", "strict-types"],
  },
  {
    kind: "skill",
    id: "omk-frontend-implementation",
    source: "project",
    roles: ["coder", "designer"],
    keywords: ["frontend", "ui", "component", "react", "design", "폼", "화면"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 2,
    capabilities: ["frontend-implementation"],
  },
  {
    kind: "skill",
    id: "omk-design-system",
    source: "project",
    roles: ["designer", "reviewer"],
    keywords: ["design", "visual", "brand", "token", "ui", "디자인"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["design-system"],
  },
  {
    kind: "mcp",
    id: "omk-project",
    source: "project",
    roles: ["router", "planner", "qa", "reviewer", "explorer"],
    keywords: ["memory", "quality", "run", "agent", "config", "checkpoint", "worktree", "mcp"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 1,
    capabilities: ["project-memory", "quality-gate", "run-state", "agent-registry"],
  },
  {
    kind: "tool",
    id: "omk_search_memory",
    source: "project",
    roles: ["router", "planner", "explorer"],
    keywords: ["memory", "prior", "previous", "recall", "메모리", "이전"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["memory-search"],
  },
  {
    kind: "tool",
    id: "omk_run_quality_gate",
    source: "project",
    roles: ["qa", "verifier", "reviewer"],
    keywords: ["quality", "gate", "lint", "typecheck", "test", "build", "검증"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 1,
    capabilities: ["quality-gate"],
  },
  {
    kind: "tool",
    id: "SearchWeb",
    source: "builtin",
    roles: ["researcher", "architect", "planner"],
    keywords: ["paper", "official", "docs", "current", "latest", "논문", "최신", "공식"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 2,
    capabilities: ["external-research"],
  },
  {
    kind: "tool",
    id: "FetchURL",
    source: "builtin",
    roles: ["researcher", "architect", "planner"],
    keywords: ["paper", "official", "docs", "source", "citation", "논문", "문서"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 2,
    capabilities: ["source-reading"],
  },
  {
    kind: "hook",
    id: "awesome-agent-skills-router.sh",
    source: "project",
    roles: ["router", "orchestrator", "planner"],
    keywords: ["prompt", "route", "skill", "agent", "orchestration", "hook", "프롬프트", "라우팅", "에이전트"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["prompt-routing", "skill-activation"],
  },
  {
    kind: "hook",
    id: "subagent-stop-audit.sh",
    source: "project",
    roles: ["reviewer", "qa", "verifier", "orchestrator"],
    keywords: ["subagent", "agent", "audit", "review", "verify", "parallel", "병렬", "검증"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["subagent-audit", "completion-check"],
  },
  {
    kind: "hook",
    id: "stop-verify.sh",
    source: "project",
    roles: ["reviewer", "qa", "verifier"],
    keywords: ["stop", "verify", "quality", "gate", "test", "검증", "테스트"],
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: ["stop-verification", "quality-gate"],
  },
  {
    kind: "hook",
    id: "protect-secrets.sh",
    source: "project",
    roles: ["security", "reviewer", "coder"],
    keywords: ["secret", "token", "credential", "env", "write", "edit", "보안", "시크릿"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 1,
    capabilities: ["secret-protection"],
  },
  {
    kind: "hook",
    id: "pre-shell-guard.sh",
    source: "project",
    roles: ["security", "coder", "qa"],
    keywords: ["shell", "command", "guard", "danger", "rm", "security", "명령", "보안"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 1,
    capabilities: ["shell-guard"],
  },
  {
    kind: "hook",
    id: "post-format.sh",
    source: "project",
    roles: ["coder", "qa", "reviewer"],
    keywords: ["format", "write", "edit", "typescript", "lint", "코드", "수정"],
    readOnly: false,
    writeRisk: "low",
    contextCost: 1,
    capabilities: ["post-format"],
  },
];

export function selectTaskRouting(input: RoutingInput): DagNodeRouting {
  const inventory = discoverRoutingInventory();
  const text = normalizeText([
    input.id,
    input.name,
    input.role,
    ...(input.inputs ?? []).flatMap((item) => [item.name, item.ref, item.from ?? ""]),
    ...(input.outputs ?? []).flatMap((item) => [item.name, item.ref ?? "", item.gate ?? ""]),
  ].join(" "));
  const readOnly = inferReadOnly(input, text);
  const evidenceRequired = inferEvidenceRequired(input, text);
  const contextBudget = inferContextBudget(input, readOnly, evidenceRequired);
  const rejected: Array<{ id: string; reason: string }> = inventory.diagnostics
    .slice(0, 3)
    .map((diagnostic) => ({
      id: `mcp-config:${diagnostic.source}`,
      reason: `${diagnostic.path}: ${diagnostic.message}`,
    }));

  const scored = routeCandidates(inventory, ROUTE_CANDIDATES).flatMap((candidate): ScoredRoute[] => {
    const rejectReason = rejectionReason(candidate, readOnly, contextBudget, inventory);
    if (rejectReason) {
      rejected.push({ id: candidate.id, reason: rejectReason });
      return [];
    }
    const scoredRoute = scoreRoute(candidate, input.role, text, evidenceRequired, contextBudget);
    return scoredRoute.score > 0 ? [scoredRoute] : [];
  }).sort((a, b) => b.score - a.score || a.candidate.contextCost - b.candidate.contextCost || a.candidate.id.localeCompare(b.candidate.id));

  const skills = unique(scored.filter((item) => item.candidate.kind === "skill").map((item) => item.candidate.id)).slice(0, limitForBudget(contextBudget, MAX_SKILLS));
  const mcpServers = unique(scored.filter((item) => item.candidate.kind === "mcp").map((item) => item.candidate.id)).slice(0, limitForBudget(contextBudget, MAX_MCP_SERVERS));
  const tools = unique(scored.filter((item) => item.candidate.kind === "tool").map((item) => item.candidate.id)).slice(0, limitForBudget(contextBudget, MAX_TOOLS));
  const hooks = unique(scored.filter((item) => item.candidate.kind === "hook").map((item) => item.candidate.id)).slice(0, limitForBudget(contextBudget, MAX_HOOKS));

  if (skills.length === 0 && readOnly && inventory.skills.has("omk-repo-explorer")) skills.push("omk-repo-explorer");
  if (skills.length === 0 && inventory.skills.has("omk-context-broker")) skills.push("omk-context-broker");
  addDefaultHookHints(hooks, inventory, input.role, readOnly, evidenceRequired);

  // Merge with skill-assigner auto-assignment
  const autoAssignment = assignSkills(input);
  const scopedAutoSkills = autoAssignment.skills.filter((skill) => inventory.skills.has(skill));
  const scopedAutoMcpServers = autoAssignment.mcpServers.filter((server) => inventory.mcpServers.has(server));
  const scopedAutoHooks = autoAssignment.hooks.filter((hook) => inventory.hooks.has(hook));
  const releaseGuardRequired = autoAssignment.rationale.includes(`[${OMK_RELEASE_GUARD_PRESET.id}]`);
  const tsProductRequired = autoAssignment.rationale.includes(`[${OMK_TS_PRODUCT_PRESET.id}]`);
  const worktreeRequired = autoAssignment.rationale.includes(`[${OMK_WORKTREE_TEAM_PRESET.id}]`);

  function requiredPresetSkills(): readonly string[] | undefined {
    const presets: string[][] = [];
    if (releaseGuardRequired) presets.push(OMK_RELEASE_GUARD_PRESET.skills);
    if (tsProductRequired) presets.push(OMK_TS_PRODUCT_PRESET.skills);
    if (worktreeRequired) presets.push(OMK_WORKTREE_TEAM_PRESET.skills);
    const active = unique(presets.flat()).filter((skill) => inventory.skills.has(skill));
    return active.length > 0 ? active : undefined;
  }
  function requiredPresetMcpServers(): readonly string[] | undefined {
    const presets: string[][] = [];
    if (releaseGuardRequired) presets.push(OMK_RELEASE_GUARD_PRESET.mcpServers);
    if (tsProductRequired) presets.push(OMK_TS_PRODUCT_PRESET.mcpServers);
    if (worktreeRequired) presets.push(OMK_WORKTREE_TEAM_PRESET.mcpServers);
    const active = unique(presets.flat()).filter((server) => inventory.mcpServers.has(server));
    return active.length > 0 ? active : undefined;
  }
  function requiredPresetHooks(): readonly string[] | undefined {
    const presets: string[][] = [];
    if (releaseGuardRequired) presets.push(OMK_RELEASE_GUARD_PRESET.hooks);
    if (tsProductRequired) presets.push(OMK_TS_PRODUCT_PRESET.hooks);
    if (worktreeRequired) presets.push(OMK_WORKTREE_TEAM_PRESET.hooks);
    const active = unique(presets.flat()).filter((hook) => inventory.hooks.has(hook));
    return active.length > 0 ? active : undefined;
  }

  const mergedSkills = mergeBoundedRoutes(
    skills,
    scopedAutoSkills,
    contextBudget,
    MAX_SKILLS,
    requiredPresetSkills()
  );
  const mergedMcpServers = mergeBoundedRoutes(
    mcpServers,
    scopedAutoMcpServers,
    contextBudget,
    MAX_MCP_SERVERS,
    requiredPresetMcpServers()
  );
  const mergedTools = unique([...tools, ...autoAssignment.tools]).slice(0, limitForBudget(contextBudget, MAX_TOOLS));
  const mergedHooks = mergeBoundedRoutes(
    hooks,
    scopedAutoHooks,
    contextBudget,
    MAX_HOOKS,
    requiredPresetHooks()
  );

  const mergedRationale = autoAssignment.skills.length > 0
    ? `${renderRationale(scored.slice(0, 3), contextBudget)} | Auto: ${autoAssignment.rationale}`
    : renderRationale(scored.slice(0, 3), contextBudget);

  return attachAssignedCapabilities({
    provider: "auto",
    fallbackProvider: resolveFallbackProvider([DEFAULT_AUTHORITY_PROVIDER]),
    providerReason: "Primary provider router decides at node execution time",
    skills: mergedSkills,
    mcpServers: mergedMcpServers,
    tools: mergedTools,
    hooks: mergedHooks,
    contextBudget,
    readOnly,
    evidenceRequired,
    rationale: mergedRationale,
    rejected: rejected.slice(0, 6),
    requiresMcp: input.routing?.requiresMcp ?? false,
    requiresToolCalling: input.routing?.requiresToolCalling ?? false,
  });
}

export function mergeDagNodeRouting(auto: DagNodeRouting, override: DagNodeRouting | undefined): DagNodeRouting {
  if (!override) return attachAssignedCapabilities(auto);
  return attachAssignedCapabilities({
    ...auto,
    ...override,
    provider: override.provider ?? auto.provider,
    fallbackProvider: override.fallbackProvider ?? auto.fallbackProvider,
    providerReason: override.providerReason ?? auto.providerReason,
    providerModelTier: override.providerModelTier ?? auto.providerModelTier,
    autoSpawned: override.autoSpawned ?? auto.autoSpawned,
    spawnReason: override.spawnReason ?? auto.spawnReason,
    routeSource: override.routeSource ?? auto.routeSource,
    skills: override.skills ? unique(override.skills) : auto.skills,
    mcpServers: override.mcpServers ? unique(override.mcpServers) : auto.mcpServers,
    tools: override.tools ? unique(override.tools) : auto.tools,
    hooks: override.hooks ? unique(override.hooks) : auto.hooks,
    rejected: override.rejected ?? auto.rejected,
  });
}

export function dagNodeRoutingEnv(node: DagNode, dag?: import("./dag.js").Dag): Record<string, string> {
  const routing = node.routing;
  if (!routing) return {};

  const scopes = capabilityScopesFromRouting(routing);
  const skillHints = new Set<string>(scopes.skills);
  const mcpHints = new Set<string>(scopes.mcpServers);
  const toolHints = new Set<string>(scopes.tools);
  const hookHints = new Set<string>(scopes.hooks);
  const parentMcpHints = new Set<string>();

  if (dag) {
    for (const parentId of node.dependsOn) {
      const parent = dag.nodes.find((n) => n.id === parentId);
      if (!parent?.routing) continue;
      for (const s of parent.routing.skills ?? []) skillHints.add(s);
      for (const m of parent.routing.mcpServers ?? []) parentMcpHints.add(m);
      for (const t of parent.routing.tools ?? []) toolHints.add(t);
      for (const h of parent.routing.hooks ?? []) hookHints.add(h);
    }
  }

  return {
    OMK_SKILL_HINTS: Array.from(skillHints).join(","),
    OMK_MCP_HINTS: Array.from(mcpHints).join(","),
    OMK_PARENT_MCP_HINTS: Array.from(parentMcpHints).join(","),
    OMK_TOOL_HINTS: Array.from(toolHints).join(","),
    OMK_HOOK_HINTS: Array.from(hookHints).join(","),
    OMK_NODE_SKILLS: scopes.skills.join(","),
    OMK_NODE_MCP_SERVERS: scopes.mcpServers.join(","),
    OMK_NODE_TOOLS: scopes.tools.join(","),
    OMK_NODE_HOOKS: scopes.hooks.join(","),
    OMK_ROUTE_SOURCE: routing.routeSource ?? "",
    OMK_ROUTE_AUTO_SPAWNED: String(routing.autoSpawned ?? false),
    OMK_ROUTE_SPAWN_REASON: routing.spawnReason ?? "",
    OMK_CONTEXT_BUDGET: routing.contextBudget ?? "small",
    OMK_ROUTE_READ_ONLY: String(routing.readOnly ?? false),
    OMK_ROUTE_EVIDENCE_REQUIRED: String(routing.evidenceRequired ?? false),
    OMK_ROUTE_RATIONALE: routing.rationale ?? "",
    OMK_PROVIDER_HINT: routing.provider ?? "auto",
    OMK_NODE_PROVIDER: routing.assignedProvider ?? routing.provider ?? "auto",
    OMK_NODE_PROVIDER_AUTHORITY: routing.assignedProviderAuthority ?? "",
    OMK_NODE_PROVIDER_CAPABILITIES: (routing.assignedProviderCapabilities ?? []).join(","),
    OMK_NODE_CANDIDATE_PROVIDERS: (routing.candidateProviders ?? []).join(","),
    OMK_PROVIDER_MODEL: routing.providerModel ?? "",
    OMK_PROVIDER_MODEL_TIER: routing.providerModelTier ?? "",
    OMK_PROVIDER_FALLBACK: routing.fallbackProvider ?? resolveFallbackProvider([DEFAULT_AUTHORITY_PROVIDER]),
    OMK_PROVIDER_REASON: routing.providerReason ?? "",
    OMK_ROUTE_REQUIRES_MCP: String(routing.requiresMcp ?? false),
    OMK_ROUTE_REQUIRES_TOOL_CALLING: String(routing.requiresToolCalling ?? false),
  };
}

function scoreRoute(
  candidate: RouteCandidate,
  role: string,
  text: string,
  evidenceRequired: boolean,
  contextBudget: DagContextBudget
): ScoredRoute {
  const roleMatch = candidate.roles.includes(role) ? 1 : 0;
  const keywordMatches = candidate.keywords.filter((keyword) => textMatchesKeyword(text, keyword)).length;
  const keywordScore = Math.min(1, keywordMatches / 2);
  const evidenceFit = evidenceRequired && candidate.capabilities.some((capability) => /quality|verification|review|official|citation/.test(capability)) ? 1 : 0;
  const smallContextFit = contextBudget === "tiny"
    ? candidate.contextCost === 1 ? 1 : 0
    : candidate.contextCost <= 2 ? 1 : 0.5;
  const safetyFit = candidate.writeRisk === "none" ? 1 : candidate.writeRisk === "low" ? 0.5 : 0;
  const localFit = candidate.source === "project" ? 0.08 : candidate.source === "builtin" ? 0.04 : 0;
  const score = (0.3 * roleMatch) + (0.25 * keywordScore) + (0.2 * evidenceFit) + (0.15 * smallContextFit) + (0.1 * safetyFit) + localFit;

  return {
    candidate,
    score,
    reason: [
      roleMatch ? "role" : "",
      keywordMatches > 0 ? `${keywordMatches} keyword` : "",
      evidenceFit ? "evidence" : "",
      smallContextFit ? "small-context" : "",
    ].filter(Boolean).join(", ") || "fallback",
  };
}

function rejectionReason(candidate: RouteCandidate, readOnly: boolean, budget: DagContextBudget, inventory: RoutingInventory): string | undefined {
  if (readOnly && candidate.writeRisk === "high") return "read-only node excludes high-risk write route";
  if (budget === "tiny" && candidate.contextCost === 3) return "tiny context budget excludes high-context route";
  if (candidate.kind === "skill" && !inventory.skills.has(candidate.id)) return `skill not installed in ${inventory.skillsScope} scope`;
  if (candidate.kind === "mcp" && !inventory.mcpServers.has(candidate.id)) return `MCP server not installed in ${inventory.mcpScope} scope`;
  if (candidate.kind === "hook" && !inventory.hooks.has(candidate.id)) return `hook not active in ${inventory.hooksScope} scope`;
  if (candidate.kind === "tool" && !inventory.tools.has(candidate.id)) return "tool unavailable from discovered MCP/builtin inventory";
  return undefined;
}

function inferReadOnly(input: RoutingInput, text: string): boolean {
  if ((input.outputs ?? []).some((output) => output.gate && output.gate !== "none")) return false;
  if (["explorer", "researcher", "reviewer", "architect", "planner", "router", "aggregator", "interviewer", "ontology", "vision-debugger"].includes(input.role)) return true;
  return !/\b(write|edit|implement|fix|create|delete|modify|코드작성|수정|구현)\b/.test(text);
}

function inferEvidenceRequired(input: RoutingInput, text: string): boolean {
  return (input.outputs ?? []).some((output) => output.gate && output.gate !== "none")
    || ["qa", "tester", "reviewer", "verifier", "aggregator"].includes(input.role)
    || /\b(test|verify|evidence|quality|gate|citation|검증|테스트|근거)\b/.test(text);
}

function inferContextBudget(input: RoutingInput, readOnly: boolean, evidenceRequired: boolean): DagContextBudget {
  if (input.cost === 1 || (readOnly && !evidenceRequired)) return "tiny";
  if (input.cost === 3) return "normal";
  return "small";
}

function limitForBudget(budget: DagContextBudget, max: number): number {
  if (budget === "tiny") return Math.max(1, Math.min(max, 2));
  if (budget === "small") return Math.max(1, max);
  return max;
}

function mergeBoundedRoutes(
  discovered: readonly string[],
  autoAssigned: readonly string[],
  budget: DagContextBudget,
  defaultMax: number,
  requiredPreset?: readonly string[]
): string[] {
  const merged = unique([...discovered, ...autoAssigned]);
  if (!requiredPreset || requiredPreset.length === 0) {
    return merged.slice(0, limitForBudget(budget, defaultMax));
  }
  const budgetLimit = limitForBudget(budget, defaultMax);
  const missing = requiredPreset.filter((id) => !merged.includes(id));
  // Preserve top discovered items within their budget limit, then append all
  // required preset items (both those already present in merged and any missing).
  const discoveredKept = merged.filter(
    (id, idx) => idx < budgetLimit && !requiredPreset.includes(id)
  );
  const presetInMerged = merged.filter((id) => requiredPreset.includes(id));
  return unique([...discoveredKept, ...presetInMerged, ...missing]);
}

function renderRationale(scored: ScoredRoute[], budget: DagContextBudget): string {
  const summary = scored.map((item) => `${item.candidate.id}(${item.reason})`).join("; ");
  return `budget=${budget}; selected=${summary || "direct"}`;
}

function addDefaultHookHints(
  hooks: string[],
  inventory: RoutingInventory,
  role: string,
  readOnly: boolean,
  evidenceRequired: boolean
): void {
  const maybePush = (id: string): void => {
    if (hooks.length >= MAX_HOOKS) return;
    if (inventory.hooks.has(id) && !hooks.includes(id)) hooks.push(id);
  };
  if (["router", "orchestrator", "planner"].includes(role)) {
    maybePush("awesome-agent-skills-router.sh");
    maybePush("session-context.sh");
  }
  if (evidenceRequired || ["reviewer", "qa", "tester", "verifier", "aggregator"].includes(role)) {
    maybePush("subagent-stop-audit.sh");
    maybePush("stop-verify.sh");
  }
  if (!readOnly) {
    maybePush("protect-secrets.sh");
    maybePush("post-format.sh");
    maybePush("pre-shell-guard.sh");
  }
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function textMatchesKeyword(text: string, keyword: string): boolean {
  const normalized = normalizeText(keyword);
  if (normalized.length < 2) return false;
  if (/^[a-z0-9]+$/.test(normalized)) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
  }
  return text.includes(normalized);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
