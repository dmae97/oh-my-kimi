/**
 * CapabilitySelector — selects capabilities based on classified intent.
 *
 * Architecture Doc §4: IntentClassifier → CapabilitySelector → RuntimeSidecar
 * Maps IntentKind + context → CapabilityPlan (skills, MCP, hooks, tools, promptMode).
 */

import type {
  ClassifiedIntent,
  CapabilityPlan,
  CommandEnvelope,
  IntentKind,
} from "./types.js";

/**
 * Role-based default capability presets.
 * Each role gets a baseline set of skills, MCP servers, hooks, and tools.
 */
const ROLE_PRESETS: Record<string, Partial<CapabilityPlan>> = {
  explorer: {
    skills: ["omk-repo-explorer", "omk-context-broker"],
    mcpServers: ["omk-project"],
    hooks: ["subagent-stop-audit.sh"],
  },
  researcher: {
    skills: ["omk-repo-explorer", "omk-research-verify", "omk-context-broker"],
    mcpServers: ["omk-project", "context7"],
    hooks: ["subagent-stop-audit.sh"],
  },
  planner: {
    skills: ["omk-plan-first", "omk-context-broker", "omk-industrial-control-loop"],
    mcpServers: ["omk-project"],
    hooks: ["subagent-stop-audit.sh"],
  },
  architect: {
    skills: ["omk-plan-first", "omk-design-system", "omk-context-broker"],
    mcpServers: ["omk-project", "context7"],
    hooks: ["subagent-stop-audit.sh"],
  },
  coder: {
    skills: ["omk-test-debug-loop", "omk-typescript-strict", "omk-python-typing"],
    mcpServers: ["omk-project"],
    hooks: ["protect-secrets.sh", "pre-shell-guard.sh", "post-format.sh"],
  },
  reviewer: {
    skills: ["omk-code-review", "omk-security-review", "omk-evidence-contract"],
    mcpServers: ["omk-project"],
    hooks: ["subagent-stop-audit.sh", "stop-verify.sh"],
  },
  security: {
    skills: ["omk-security-review", "omk-secret-guard", "omk-code-review"],
    mcpServers: ["omk-project"],
    hooks: ["protect-secrets.sh", "pre-shell-guard.sh"],
  },
  qa: {
    skills: ["omk-quality-gate", "omk-test-debug-loop", "omk-evidence-contract"],
    mcpServers: ["omk-project"],
    hooks: ["stop-verify.sh", "pre-shell-guard.sh"],
  },
  tester: {
    skills: ["omk-quality-gate", "omk-test-debug-loop", "omk-evidence-contract"],
    mcpServers: ["omk-project"],
    hooks: ["stop-verify.sh", "pre-shell-guard.sh"],
  },
  integrator: {
    skills: ["omk-git-commit-pr", "omk-context-broker", "omk-evidence-contract"],
    mcpServers: ["omk-project"],
    hooks: ["branch-diff-snapshot.sh", "stop-verify.sh"],
  },
};

/**
 * Intent-based capability overlays.
 * These are applied ON TOP of role presets.
 */
const INTENT_OVERLAYS: Record<IntentKind, Partial<CapabilityPlan>> = {
  debugging: {
    skills: ["omk-flow-bugfix"],
    promptMode: "compact",
    providerHints: { requireToolCalling: true },
  },
  review: {
    skills: ["omk-code-review", "omk-multimodal-ui-review"],
    promptMode: "full",
    providerHints: { requireToolCalling: true },
  },
  "test-generation": {
    skills: ["omk-flow-bugfix"],
    promptMode: "compact",
    providerHints: { requireToolCalling: true },
  },
  refactor: {
    skills: ["omk-flow-refactor", "omk-flow-feature-dev"],
    promptMode: "compact",
    providerHints: { requireToolCalling: true },
  },
  research: {
    skills: ["omk-research-verify"],
    promptMode: "full",
    providerHints: { requireMcp: true },
  },
  planning: {
    skills: ["omk-plan-first", "speckit-specify", "speckit-plan"],
    promptMode: "full",
    providerHints: {},
  },
  documentation: {
    skills: ["omk-docs-release"],
    promptMode: "nlp",
    providerHints: {},
  },
  "shell-operation": {
    promptMode: "minimal",
    providerHints: { requireToolCalling: true },
  },
  coding: {
    skills: ["omk-flow-feature-dev"],
    promptMode: "compact",
    providerHints: { requireToolCalling: true },
  },
  chat: {
    promptMode: "nlp",
    providerHints: {},
  },
  unknown: {
    promptMode: "nlp",
    providerHints: {},
  },
};

/**
 * Merge multiple partial CapabilityPlans into one.
 * Arrays are concatenated and deduplicated. Last-write wins for scalars.
 */
function mergePlans(...plans: readonly Partial<CapabilityPlan>[]): CapabilityPlan {
  const skills = new Set<string>();
  const mcpServers = new Set<string>();
  const hooks = new Set<string>();
  const tools = new Set<string>();
  let promptMode: CapabilityPlan["promptMode"] = "nlp";
  const providerHints: CapabilityPlan["providerHints"] = {};
  const rationales: string[] = [];

  for (const plan of plans) {
    if (plan.skills) for (const s of plan.skills) skills.add(s);
    if (plan.mcpServers) for (const m of plan.mcpServers) mcpServers.add(m);
    if (plan.hooks) for (const h of plan.hooks) hooks.add(h);
    if (plan.tools) for (const t of plan.tools) tools.add(t);
    if (plan.promptMode) promptMode = plan.promptMode;
    if (plan.providerHints) {
      Object.assign(providerHints, plan.providerHints);
    }
    if (plan.rationale) rationales.push(plan.rationale);
  }

  return {
    skills: [...skills],
    mcpServers: [...mcpServers],
    hooks: [...hooks],
    tools: [...tools],
    promptMode,
    providerHints,
    rationale: rationales.join("; ") || "default",
  };
}

/**
 * Select capabilities based on classified intent and envelope context.
 *
 * Flow: role preset → intent overlay → envelope overrides → final plan
 */
export function selectCapabilities(
  intent: ClassifiedIntent,
  envelope?: CommandEnvelope,
  role?: string
): CapabilityPlan {
  const effectiveRole = role ?? inferRole(envelope);
  const rolePreset = ROLE_PRESETS[effectiveRole] ?? {};
  const intentOverlay = INTENT_OVERLAYS[intent.kind] ?? {};

  // Envelope-level overrides
  const envelopeHints = envelope?.runtime?.provider
    ? { preferProvider: envelope.runtime.provider }
    : undefined;

  const plan = mergePlans(
    { rationale: `role:${effectiveRole}` },
    rolePreset,
    { rationale: `intent:${intent.kind} (conf=${intent.confidence.toFixed(2)})` },
    intentOverlay,
    ...(envelopeHints ? [{ providerHints: envelopeHints }] : [])
  );

  return plan;
}

/**
 * Infer role from envelope context.
 */
function inferRole(envelope?: CommandEnvelope): string {
  if (!envelope) return "coder";
  switch (envelope.kind) {
    case "plan": return "planner";
    case "task": return "coder";
    case "chat": return "coder";
    case "run": return "coder";
    case "provider": return "explorer";
    case "theme": return "explorer";
    case "doctor": return "explorer";
    default: return "coder";
  }
}

/**
 * Create a minimal CapabilityPlan for sub-agents.
 * Used by ParallelOrchestrator when dispatching worker tasks.
 */
export function createSubAgentCapabilityPlan(
  role: string,
  extraSkills: readonly string[] = [],
  extraMcp: readonly string[] = []
): CapabilityPlan {
  const rolePreset = ROLE_PRESETS[role] ?? ROLE_PRESETS.coder!;
  return mergePlans(
    rolePreset,
    {
      skills: [...extraSkills],
      mcpServers: [...extraMcp],
      rationale: `sub-agent role:${role}`,
    }
  );
}
