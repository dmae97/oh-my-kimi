/**
 * SkillAssigner — automatic skill/MCP/hook assignment for DAG nodes.
 *
 * Analyzes node role, intent, and task characteristics to determine
 * the optimal set of skills, MCP servers, tools, and hooks.
 * Records the assignment decision to the unified decision trace store.
 *
 * v2.0: Externalized ROLE_DEFAULTS to config/skill-presets.json
 *       with schema validation and runtime reload.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import type { DagNode, DagNodeRouting } from "./dag.js";
import { attachAssignedCapabilities } from "./capability-routing.js";
import type { NodeIntent } from "../runtime/runtime-router.js";
import { createDecisionTraceStore } from "../evidence/decision-trace.js";
import type { RoutingInput } from "./routing.js";
import {
  OMK_CORE_VERIFIED_PRESET,
  OMK_RELEASE_GUARD_PRESET,
  OMK_TS_PRODUCT_PRESET,
  OMK_WORKTREE_TEAM_PRESET,
  isCoreVerifiedIntent,
  isReleaseGuardIntent,
  isTsProductIntent,
  isWorktreeTeamIntent,
} from "../runtime/core-verified-preset.js";

export interface SkillAssignment {
  readonly skills: readonly string[];
  readonly mcpServers: readonly string[];
  readonly tools: readonly string[];
  readonly hooks: readonly string[];
  readonly rationale: string;
}

interface AssignmentRule {
  readonly id: string;
  readonly match: (node: DagNode, intent: NodeIntent) => boolean;
  readonly assign: Partial<Pick<DagNodeRouting, "skills" | "mcpServers" | "tools" | "hooks">>;
  readonly priority: number;
  readonly rationale: string;
}

interface SkillPreset {
  readonly skills?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly tools?: readonly string[];
  readonly hooks?: readonly string[];
}

interface SkillPresetsSchema {
  readonly version: string;
  readonly presets: Record<string, SkillPreset>;
}

// —— In-memory cache with validation ——
let _roleDefaults: Record<string, SkillPreset> | null = null;
let _presetsPath: string | null = null;
let _presetsVersion: string = "inline";

function getPresetsPath(): string {
  if (_presetsPath) return _presetsPath;
  // Resolve relative to project root (dist-aware)
  const root = process.cwd();
  _presetsPath = join(root, "src", "config", "skill-presets.json");
  return _presetsPath;
}

function validatePresets(data: unknown): data is SkillPresetsSchema {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.version !== "string") return false;
  if (typeof d.presets !== "object" || d.presets === null) return false;
  for (const preset of Object.values(d.presets)) {
    if (typeof preset !== "object" || preset === null) return false;
    const p = preset as Record<string, unknown>;
    for (const key of ["skills", "mcpServers", "tools", "hooks"]) {
      if (p[key] !== undefined && !Array.isArray(p[key])) return false;
      if (p[key] !== undefined && (p[key] as unknown[]).some((v) => typeof v !== "string")) return false;
    }
  }
  return true;
}

export async function loadRoleDefaults(force = false): Promise<Record<string, SkillPreset>> {
  if (_roleDefaults && !force) return _roleDefaults;

  try {
    const raw = await readFile(getPresetsPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!validatePresets(parsed)) {
      throw new Error("Invalid skill-presets.json schema");
    }
    _roleDefaults = parsed.presets;
    _presetsVersion = parsed.version;
    return _roleDefaults;
  } catch {
    // Memory-injection safety: fall back to inline hard-coded defaults on any error
    _roleDefaults = ROLE_DEFAULTS_FALLBACK;
    _presetsVersion = "fallback";
    return _roleDefaults;
  }
}

export function getRoleDefaultsSync(): Record<string, SkillPreset> {
  if (_roleDefaults) return _roleDefaults;
  return ROLE_DEFAULTS_FALLBACK;
}

/** Hard-coded fallback — always safe, never depends on external file integrity */
const ROLE_DEFAULTS_FALLBACK: Record<string, SkillPreset> = {
  explorer: { skills: ["omk-repo-explorer", "omk-context-broker", "omk-research-verify"], mcpServers: ["omk-project"], hooks: ["subagent-stop-audit.sh"] },
  researcher: { skills: ["omk-repo-explorer", "omk-research-verify", "omk-context-broker", "omk-plan-first"], mcpServers: ["omk-project", "context7"], hooks: ["subagent-stop-audit.sh"] },
  planner: { skills: ["omk-plan-first", "omk-context-broker", "omk-industrial-control-loop", "speckit-plan", "speckit-specify"], mcpServers: ["omk-project"], hooks: ["subagent-stop-audit.sh"] },
  architect: { skills: ["omk-plan-first", "omk-design-system", "omk-context-broker", "omk-industrial-control-loop"], mcpServers: ["omk-project", "context7"], hooks: ["subagent-stop-audit.sh"] },
  coder: { skills: ["omk-test-debug-loop", "omk-typescript-strict", "omk-python-typing", "omk-frontend-implementation", "matt-pocock-skills", "andrej-karpathy-skills", "omk-flow-feature-dev", "omk-flow-refactor"], mcpServers: ["omk-project"], hooks: ["protect-secrets.sh", "pre-shell-guard.sh", "post-format.sh"] },
  reviewer: { skills: ["omk-code-review", "omk-security-review", "omk-frontend-ui-review", "omk-backend-api-review", "omk-evidence-contract", "omk-multimodal-ui-review"], mcpServers: ["omk-project"], hooks: ["subagent-stop-audit.sh", "stop-verify.sh"] },
  security: { skills: ["omk-security-review", "omk-secret-guard", "omk-code-review", "omk-evidence-contract"], mcpServers: ["omk-project"], hooks: ["protect-secrets.sh", "pre-shell-guard.sh", "stop-verify.sh"] },
  qa: { skills: ["omk-quality-gate", "omk-test-debug-loop", "omk-typescript-strict", "omk-python-typing", "omk-evidence-contract"], mcpServers: ["omk-project"], hooks: ["stop-verify.sh", "pre-shell-guard.sh"] },
  tester: { skills: ["omk-quality-gate", "omk-test-debug-loop", "omk-flow-bugfix", "omk-evidence-contract"], mcpServers: ["omk-project"], hooks: ["stop-verify.sh", "pre-shell-guard.sh"] },
  integrator: { skills: ["omk-git-commit-pr", "omk-context-broker", "omk-evidence-contract"], mcpServers: ["omk-project"], hooks: ["branch-diff-snapshot.sh", "subagent-stop-audit.sh", "stop-verify.sh"] },
  aggregator: { skills: ["omk-code-review", "omk-context-broker", "omk-evidence-contract", "omk-industrial-control-loop"], mcpServers: ["omk-project"], hooks: ["subagent-stop-audit.sh", "stop-verify.sh"] },
  interviewer: { skills: ["omk-context-broker", "speckit-clarify", "speckit-checklist", "omk-plan-first"], mcpServers: ["omk-project"], hooks: ["subagent-stop-audit.sh"] },
  "vision-debugger": { skills: ["omk-multimodal-ui-review", "omk-design-md"], mcpServers: ["omk-project"], hooks: ["pre-shell-guard.sh"] },
  ontology: { skills: ["omk-context-broker", "graph-view", "agentmemory"], mcpServers: ["omk-project"], hooks: ["subagent-stop-audit.sh"] },
};

const SKILL_RULES: readonly AssignmentRule[] = [
  {
    id: OMK_CORE_VERIFIED_PRESET.id,
    match: (_node, intent) => isCoreVerifiedIntent(intent),
    assign: {
      skills: [...OMK_CORE_VERIFIED_PRESET.skills],
      mcpServers: [...OMK_CORE_VERIFIED_PRESET.mcpServers],
      hooks: [...OMK_CORE_VERIFIED_PRESET.hooks],
    },
    priority: 10,
    rationale: OMK_CORE_VERIFIED_PRESET.purpose,
  },
  {
    id: OMK_TS_PRODUCT_PRESET.id,
    match: (node, intent) => isTsProductIntent(intent, `${node.id} ${node.name} ${node.role}`),
    assign: {
      skills: [...OMK_TS_PRODUCT_PRESET.skills],
      mcpServers: [...OMK_TS_PRODUCT_PRESET.mcpServers],
      hooks: [...OMK_TS_PRODUCT_PRESET.hooks],
    },
    priority: 20,
    rationale: OMK_TS_PRODUCT_PRESET.purpose,
  },
  {
    id: OMK_WORKTREE_TEAM_PRESET.id,
    match: (node, intent) => isWorktreeTeamIntent(intent, `${node.id} ${node.name} ${node.role}`),
    assign: {
      skills: [...OMK_WORKTREE_TEAM_PRESET.skills],
      mcpServers: [...OMK_WORKTREE_TEAM_PRESET.mcpServers],
      hooks: [...OMK_WORKTREE_TEAM_PRESET.hooks],
    },
    priority: 25,
    rationale: OMK_WORKTREE_TEAM_PRESET.purpose,
  },
  {
    id: OMK_RELEASE_GUARD_PRESET.id,
    match: (node, intent) => isReleaseGuardIntent(intent, `${node.id} ${node.name} ${node.role}`),
    assign: {
      skills: [...OMK_RELEASE_GUARD_PRESET.skills],
      mcpServers: [...OMK_RELEASE_GUARD_PRESET.mcpServers],
      hooks: [...OMK_RELEASE_GUARD_PRESET.hooks],
    },
    priority: 92,
    rationale: OMK_RELEASE_GUARD_PRESET.purpose,
  },
  {
    id: "web-design",
    match: (_node, intent) =>
      ["coding", "documentation", "planning"].includes(intent) &&
      /web|page|landing|dashboard|prototype|ui|mockup|slide|deck|animation|visual|html|css|react/i.test(
        `${_node.name} ${_node.role}`
      ),
    assign: { skills: ["web-design-engineer"] },
    priority: 90,
    rationale: "Visual front-end deliverable detected",
  },
  {
    id: "diagram-design",
    match: (_node, _intent) =>
      /diagram|chart|flowchart|architecture|timeline|swimlane|quadrant|tree|layer|venn|pyramid|er\s*diagram/i.test(
        `${_node.name} ${_node.role}`
      ),
    assign: { skills: ["diagram-design"] },
    priority: 95,
    rationale: "Diagram or chart generation detected",
  },
  {
    id: "kb-retriever",
    match: (_node, intent) =>
      ["research", "planning"].includes(intent) &&
      /knowledge|kb|retrieve|search|pdf|excel|document|report/i.test(
        `${_node.name} ${_node.role}`
      ),
    assign: { skills: ["kb-retriever"] },
    priority: 85,
    rationale: "Knowledge-base retrieval or document analysis detected",
  },
  {
    id: "code-review",
    match: (_node, intent) =>
      intent === "review" ||
      /review|audit|check|validate|verify|pr\s*review/i.test(
        `${_node.name} ${_node.role}`
      ),
    assign: { skills: ["omk-code-review", "omk-multimodal-ui-review"] },
    priority: 90,
    rationale: "Code or UI review task detected",
  },
  {
    id: "spec-driven",
    match: (_node, intent) =>
      ["planning", "coding"].includes(intent) &&
      /spec|specify|plan|architecture|design.*doc|constitution/i.test(
        `${_node.name} ${_node.role}`
      ),
    assign: { skills: ["speckit-specify", "speckit-plan", "omk-plan-first"] },
    priority: 80,
    rationale: "Specification or architecture planning detected",
  },
  {
    id: "security-audit",
    match: (_node, intent) =>
      intent === "review" &&
      /security|audit|secret|vulnerability|auth|permission/i.test(
        `${_node.name} ${_node.role}`
      ),
    assign: { skills: ["omk-flow-bugfix", "omk-code-review"] },
    priority: 95,
    rationale: "Security-sensitive review detected",
  },
  {
    id: "debugging",
    match: (_node, intent) =>
      intent === "debugging" ||
      /debug|fix|error|failure|bug|trace|investigate/i.test(
        `${_node.name} ${_node.role}`
      ),
    assign: { skills: ["omk-flow-bugfix"] },
    priority: 85,
    rationale: "Debugging or bug-fix task detected",
  },
  {
    id: "feature-dev",
    match: (_node, intent) =>
      intent === "coding" &&
      /feature|implement|build|create|develop/i.test(
        `${_node.name} ${_node.role} ${_node.name}`
      ),
    assign: { skills: ["omk-flow-feature-dev", "omk-design-md"] },
    priority: 80,
    rationale: "Feature development detected",
  },
  {
    id: "refactor",
    match: (_node, intent) =>
      intent === "refactor" ||
      /refactor|optimize|clean|improve|simplify/i.test(
        `${_node.name} ${_node.role} ${_node.name}`
      ),
    assign: { skills: ["omk-flow-refactor", "omk-flow-feature-dev"] },
    priority: 85,
    rationale: "Refactoring task detected",
  },
  {
    id: "release",
    match: (_node, _intent) =>
      /release|deploy|publish|version|changelog|tag/i.test(
        `${_node.name} ${_node.role} ${_node.name}`
      ),
    assign: { skills: ["omk-flow-release"] },
    priority: 90,
    rationale: "Release or deployment task detected",
  },
  {
    id: "team-run",
    match: (_node, _intent) =>
      /team|parallel|multi.*agent|orchestrate|workflow/i.test(
        `${_node.name} ${_node.role} ${_node.name}`
      ),
    assign: { skills: ["omk-flow-team-run", "omk-task-router"] },
    priority: 85,
    rationale: "Multi-agent team run detected",
  },
  {
    id: "mcp-required",
    match: (_node) => _node.routing?.requiresMcp === true,
    assign: { mcpServers: ["context7", "fetch", "filesystem-readonly"] },
    priority: 100,
    rationale: "Node explicitly requires MCP authority with read-only filesystem by default",
  },
  {
    id: "tool-calling",
    match: (_node) => _node.routing?.requiresToolCalling === true,
    assign: { tools: ["search", "read", "write"] },
    priority: 100,
    rationale: "Node explicitly requires tool calling",
  },
];

// —— Unified intent classifier (deduplicated) ——
function classifyIntent(text: string, role: string): NodeIntent {
  const t = text.toLowerCase();
  if (/debug|fix|error|failure|bug|trace/.test(t) || role === "debugger") return "debugging";
  if (/review|audit|check|validate|verify/.test(t) || role === "reviewer") return "review";
  if (/test|spec|coverage|assertion/.test(t) || role === "tester") return "test-generation";
  if (/refactor|optimize|clean|improve|simplify/.test(t) || role === "refactor") return "refactor";
  if (/research|investigate|explore|search|discover|analyze/.test(t) || role === "researcher") return "research";
  if (/plan|design|architect|strategy|roadmap/.test(t) || role === "planner") return "planning";
  if (/doc|readme|changelog|comment/.test(t) || role === "documenter") return "documentation";
  if (/shell|command|run|exec|script/.test(t) || role === "shell") return "shell-operation";
  return "coding";
}

export function classifyNodeIntent(node: DagNode): NodeIntent {
  return classifyIntent(`${node.id} ${node.name} ${node.role}`, node.role);
}

export function classifyRoutingIntent(input: RoutingInput): NodeIntent {
  return classifyIntent(`${input.id} ${input.name} ${input.role}`, input.role);
}

export function assignSkills(
  node: DagNode,
  runId?: string,
  attemptId?: string
): SkillAssignment;
export function assignSkills(
  input: RoutingInput,
  runId?: string,
  attemptId?: string
): SkillAssignment;
export function assignSkills(
  arg: DagNode | RoutingInput,
  runId?: string,
  attemptId?: string
): SkillAssignment {
  if (isDagNode(arg)) {
    return doAssignSkills(arg, classifyNodeIntent(arg), runId, attemptId);
  }
  return doAssignSkillsForRoutingInput(arg, classifyRoutingIntent(arg), runId, attemptId);
}

function isDagNode(arg: DagNode | RoutingInput): arg is DagNode {
  return "dependsOn" in arg;
}

function doAssignSkills(
  node: DagNode,
  intent: NodeIntent,
  runId?: string,
  attemptId?: string
): SkillAssignment {
  const nodeText = `${node.id} ${node.name} ${node.role}`;
  const roleDefaults = getRoleDefaultsSync()[node.role];

  const matched = SKILL_RULES
    .filter((rule) => rule.match(node, intent))
    .sort((a, b) => b.priority - a.priority);

  return buildAssignment(matched, intent, nodeText, node.routing, runId, attemptId, node.id, roleDefaults);
}

function doAssignSkillsForRoutingInput(
  input: RoutingInput,
  intent: NodeIntent,
  runId?: string,
  attemptId?: string
): SkillAssignment {
  const nodeText = `${input.id} ${input.name} ${input.role}`;

  const adaptedNode: DagNode = {
    id: input.id,
    name: input.name,
    role: input.role,
    dependsOn: [],
    status: "pending",
    retries: 0,
    maxRetries: 3,
    routing: input.routing ?? {},
  };

  const roleDefaults = getRoleDefaultsSync()[input.role];

  const matched = SKILL_RULES
    .filter((rule) => rule.match(adaptedNode, intent))
    .sort((a, b) => b.priority - a.priority);

  return buildAssignment(matched, intent, nodeText, input.routing, runId, attemptId, input.id, roleDefaults);
}

function buildAssignment(
  matched: readonly AssignmentRule[],
  intent: NodeIntent,
  nodeText: string,
  routing: DagNodeRouting | undefined,
  runId: string | undefined,
  attemptId: string | undefined,
  nodeId: string,
  roleDefaults?: SkillPreset
): SkillAssignment {
  const skills = new Set<string>();
  const mcpServers = new Set<string>();
  const tools = new Set<string>();
  const hooks = new Set<string>();
  const rationales: string[] = [];

  // Apply role defaults first
  if (roleDefaults) {
    if (roleDefaults.skills) {
      for (const s of roleDefaults.skills) skills.add(s);
    }
    if (roleDefaults.mcpServers) {
      for (const m of roleDefaults.mcpServers) mcpServers.add(m);
    }
    if (roleDefaults.tools) {
      for (const t of roleDefaults.tools) tools.add(t);
    }
    if (roleDefaults.hooks) {
      for (const h of roleDefaults.hooks) hooks.add(h);
    }
    rationales.push(`[role-default] Default capability set for ${nodeText.split(" ")[2] ?? ""} (v${_presetsVersion})`);
  }

  for (const rule of matched) {
    if (rule.assign.skills) {
      for (const s of rule.assign.skills) skills.add(s);
    }
    if (rule.assign.mcpServers) {
      for (const m of rule.assign.mcpServers) mcpServers.add(m);
    }
    if (rule.assign.tools) {
      for (const t of rule.assign.tools) tools.add(t);
    }
    if (rule.assign.hooks) {
      for (const h of rule.assign.hooks) hooks.add(h);
    }
    rationales.push(`[${rule.id}] ${rule.rationale}`);
  }

  // Preserve manually assigned values
  if (routing?.skills) {
    for (const s of routing.skills) skills.add(s);
  }
  if (routing?.mcpServers) {
    for (const m of routing.mcpServers) mcpServers.add(m);
  }
  if (routing?.tools) {
    for (const t of routing.tools) tools.add(t);
  }
  if (routing?.hooks) {
    for (const h of routing.hooks) hooks.add(h);
  }

  const rationale = rationales.length > 0
    ? `Auto-assigned for intent=${intent}: ${rationales.join("; ")}`
    : `No auto-assignment for intent=${intent}`;

  const assignment: SkillAssignment = {
    skills: Array.from(skills),
    mcpServers: Array.from(mcpServers),
    tools: Array.from(tools),
    hooks: Array.from(hooks),
    rationale,
  };

  // Record decision trace
  if (runId && !runId.startsWith("local-")) {
    const traceStore = createDecisionTraceStore();
    traceStore.record(runId, {
      component: "skill-assigner",
      inputSummary: `node=${nodeId} role=${nodeText.split(" ")[2] ?? ""} intent=${intent}`,
      outputDecision: `skills=${assignment.skills.join(",")} mcp=${assignment.mcpServers.join(",")} tools=${assignment.tools.join(",")} hooks=${assignment.hooks.join(",")}`,
      reason: rationale,
      scores: { matchedRules: matched.length, priorityMax: matched[0]?.priority ?? 0 },
      nodeId,
      attemptId,
    });
  }

  return assignment;
}

export function applySkillAssignment(node: DagNode, assignment: SkillAssignment): DagNode {
  return {
    ...node,
    routing: attachAssignedCapabilities({
      ...node.routing,
      skills: [...assignment.skills],
      mcpServers: [...assignment.mcpServers],
      tools: [...assignment.tools],
      hooks: [...assignment.hooks],
      rationale: assignment.rationale,
      routeSource: "skill",
    }),
  };
}
