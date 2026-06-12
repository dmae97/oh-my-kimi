import type { ActionAtom, ActionAtomVerb, IntentFrame } from "../contracts/goal.js";
import type {
  ExecutionStrategy,
  TaskType,
  UserIntentV2,
} from "../contracts/orchestration.js";
import { actionAtomRouting, makeActionAtom, renderActionDigest } from "../goal/intent-frame.js";
import type { InputEnvelope } from "../input/input-envelope.js";
import type { ProviderPolicy } from "../providers/types.js";
import type { DagNodeDefinition, DagOutputGate } from "./dag.js";

export interface RoleSpecificDagPresetInput {
  input: InputEnvelope;
  intent: UserIntentV2;
  intentFrame: IntentFrame;
  workerCount: number;
  executionStrategy: ExecutionStrategy;
  providerPolicy: ProviderPolicy;
}

export function shouldCompileRoleSpecificDag(input: {
  input: InputEnvelope;
}): boolean {
  return input.input.kind !== "slash-command";
}

export function buildRoleSpecificDagNodes(
  input: RoleSpecificDagPresetInput,
): DagNodeDefinition[] {
  if (input.intent.isReadOnly) return buildReadOnlyDag(input);
  return buildWorkDag(input);
}

function buildReadOnlyDag(input: RoleSpecificDagPresetInput): DagNodeDefinition[] {
  const evidenceRequired = shouldRequireEvidence(input.intent);
  const readLane: DagNodeDefinition = {
    id: "read-lane",
    name: readOnlyLaneName(input.intent.taskType),
    role: readOnlyRole(input.intent.taskType),
    dependsOn: ["intent-router"],
    maxRetries: 1,
    inputs: [{ name: "intent analysis", ref: "intent-analysis.json", from: "intent-router" }],
    outputs: [{ name: "read-only summary", gate: "summary", ref: "summary.md" }],
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "review", "advisory"],
      evidenceRequired,
      actionAtom: actionAtomRouting(firstAtom(input.intentFrame, "inspect")),
      rationale: "Read-only InputEnvelope compiled into a bounded inspect lane with a summary gate",
    },
  };
  return [
    buildBootstrapNode(input),
    buildIntentRouterNode(input),
    readLane,
    buildLoopDecisionNode(input, [readLane.id], evidenceRequired),
  ];
}

function buildWorkDag(input: RoleSpecificDagPresetInput): DagNodeDefinition[] {
  const evidenceRequired = shouldRequireEvidence(input.intent);
  const workerRoles = selectWorkerRoles(input.intent);
  const workerTotal = Math.max(
    1,
    input.executionStrategy === "sequential" ? 1 : input.workerCount,
  );
  const workers = Array.from({ length: workerTotal }, (_, index) => {
    const role = workerRoles[index % workerRoles.length] ?? "coder";
    const atom = input.intentFrame.actionAtoms[index] ?? firstAtom(input.intentFrame, "modify");
    return buildWorkerNode(input, index + 1, role, atom, evidenceRequired);
  });
  const workerIds = workers.map((node) => node.id);
  const evidenceVerifier = buildEvidenceVerifierNode(input, workerIds, evidenceRequired);
  const reviewMerge = buildReviewMergeNode(input, [evidenceVerifier.id]);
  const tailNodes: DagNodeDefinition[] = [evidenceVerifier, reviewMerge];

  if (input.intent.needsSecurityReview) {
    tailNodes.push(buildSecurityAuditNode(input, [reviewMerge.id]));
  }
  if (input.intent.needsDesignReview) {
    tailNodes.push(buildDesignReviewNode(input, [reviewMerge.id]));
  }

  const loopDeps = tailNodes
    .filter((node) => node.id !== evidenceVerifier.id)
    .map((node) => node.id);

  return [
    buildBootstrapNode(input),
    buildIntentRouterNode(input),
    buildPlannerNode(input),
    buildCapabilityRouterNode(input),
    ...workers,
    ...tailNodes,
    buildLoopDecisionNode(input, loopDeps, evidenceRequired),
  ];
}

function buildBootstrapNode(input: RoleSpecificDagPresetInput): DagNodeDefinition {
  return {
    id: "bootstrap",
    name: "Prepare InputEnvelope run",
    role: "omk",
    dependsOn: [],
    maxRetries: 1,
    outputs: [{ name: "input envelope", gate: "summary", ref: "input-envelope.json" }],
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "route"],
      actionAtom: actionAtomRouting(runtimeAtom({
        id: "atom-bootstrap",
        label: "bootstrap-input-envelope",
        verb: "bootstrap",
        object: "input envelope run",
        evidenceTarget: "input-envelope.json",
        doneCondition: "InputEnvelope and run metadata are available before routing",
      })),
      rationale: "Initialize the compiled DAG from a persisted InputEnvelope",
    },
  };
}

function buildIntentRouterNode(input: RoleSpecificDagPresetInput): DagNodeDefinition {
  return {
    id: "intent-router",
    name: "Route intent and execution strategy",
    role: "router",
    dependsOn: ["bootstrap"],
    maxRetries: 1,
    inputs: [{ name: "input envelope", ref: "input-envelope.json", from: "bootstrap" }],
    outputs: [{ name: "intent analysis", gate: "summary", ref: "intent-analysis.json" }],
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "route", "advisory"],
      evidenceRequired: true,
      actionAtom: actionAtomRouting(runtimeAtom({
        id: "atom-intent-router",
        label: "route-intent",
        verb: "route",
        object: "UserIntentV2 and execution strategy",
        evidenceTarget: "intent-analysis.json",
        doneCondition: "Intent, routing hints, and ambiguity signals are recorded",
      })),
      rationale: "Normalize the operator input into UserIntentV2 before planning",
    },
  };
}

function buildPlannerNode(input: RoleSpecificDagPresetInput): DagNodeDefinition {
  return {
    id: "planner",
    name: plannerName(input.intent.taskType),
    role: plannerRole(input.intent.taskType),
    dependsOn: ["intent-router"],
    maxRetries: 1,
    inputs: [{ name: "intent analysis", ref: "intent-analysis.json", from: "intent-router" }],
    outputs: [{ name: "worker plan", gate: "summary", ref: "plan.md" }],
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "plan", "advisory"],
      evidenceRequired: true,
      executionPrompt: renderActionDigest(input.intentFrame),
      actionAtom: actionAtomRouting(firstAtom(input.intentFrame, "plan")),
      rationale: "Decompose the requested outcome into worker-owned action atoms",
    },
  };
}

function buildCapabilityRouterNode(input: RoleSpecificDagPresetInput): DagNodeDefinition {
  return {
    id: "capability-router",
    name: "Bind MCP skills hooks and tools to worker lanes",
    role: "router",
    dependsOn: ["planner"],
    maxRetries: 1,
    inputs: [{ name: "worker plan", ref: "plan.md", from: "planner" }],
    outputs: [{ name: "capability routing", gate: "summary", ref: "capability-routing.json" }],
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "route", "mcp"],
      requiresMcp: input.intentFrame.capabilityHints.needsMcp,
      requiresToolCalling: input.intentFrame.capabilityHints.tools.length > 0,
      skills: input.intentFrame.capabilityHints.skills,
      mcpServers: input.intentFrame.capabilityHints.mcpServers,
      tools: input.intentFrame.capabilityHints.tools,
      hooks: input.intentFrame.capabilityHints.hooks,
      evidenceRequired: true,
      actionAtom: actionAtomRouting(runtimeAtom({
        id: "atom-capability-router",
        label: "route-capabilities",
        verb: "route",
        object: "tool plane capabilities",
        evidenceTarget: "capability-routing.json",
        doneCondition: "Workers receive bounded MCP, skill, hook, and tool routing hints",
      })),
      rationale: "Make tool-plane authority explicit before fanout",
    },
  };
}

function buildWorkerNode(
  input: RoleSpecificDagPresetInput,
  index: number,
  role: string,
  atom: ActionAtom,
  evidenceRequired: boolean,
): DagNodeDefinition {
  const readOnly = input.intent.isReadOnly || isReadOnlyRole(role);
  return {
    id: `worker-${index}`,
    name: `${role} lane ${index}: ${workerTaskName(input.intent.taskType, index)}`,
    role,
    dependsOn: ["planner", "capability-router"],
    maxRetries: 1,
    inputs: [
      { name: "worker plan", ref: "plan.md", from: "planner" },
      { name: "capability routing", ref: "capability-routing.json", from: "capability-router" },
    ],
    outputs: [{ name: `worker-${index} output`, gate: readOnly ? "summary" : "none", ref: `worker-${index}.md` }],
    failurePolicy: { retryable: true, blockDependents: true },
    routing: {
      ...baseRouting(input, readOnly),
      assignedProviderCapabilities: readOnly
        ? ["read", "review", "advisory"]
        : ["write", "patch", "shell"],
      evidenceRequired,
      actionAtom: actionAtomRouting(atom),
      rationale: `Worker lane ${index} owns action atom ${atom.id}`,
    },
  };
}

function buildEvidenceVerifierNode(
  input: RoleSpecificDagPresetInput,
  workerIds: string[],
  evidenceRequired: boolean,
): DagNodeDefinition {
  return {
    id: "evidence-verifier",
    name: verifierName(input.intent.taskType),
    role: input.intent.taskType === "test" ? "tester" : "qa",
    dependsOn: workerIds,
    maxRetries: 1,
    inputs: workerIds.map((id) => ({ name: `${id} output`, ref: `${id}.md`, from: id })),
    outputs: [{ name: "evidence result", gate: evidenceGate(input.intent), ref: "evidence.md" }],
    failurePolicy: { retryable: true, blockDependents: evidenceRequired },
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "test", "review"],
      evidenceRequired,
      actionAtom: actionAtomRouting(runtimeAtom({
        id: "atom-evidence-verifier",
        label: "verify-evidence",
        verb: input.intent.needsTesting ? "test" : "verify",
        object: "worker evidence",
        evidenceTarget: "evidence.md",
        doneCondition: "Required gates are checked before merge",
      })),
      rationale: "Lock evidence before merge or loop decision",
    },
  };
}

function buildReviewMergeNode(
  input: RoleSpecificDagPresetInput,
  dependsOn: string[],
): DagNodeDefinition {
  return {
    id: "review-merge",
    name: input.intent.taskType === "review" ? "Aggregate review findings" : "Review and merge verified outputs",
    role: input.intent.taskType === "review" ? "aggregator" : "reviewer",
    dependsOn,
    maxRetries: 1,
    inputs: dependsOn.map((id) => ({ name: `${id} result`, ref: "state.json", from: id })),
    outputs: [{ name: "verified result", gate: "review-pass", ref: "final-report.md" }],
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "review", "advisory"],
      evidenceRequired: true,
      actionAtom: actionAtomRouting(runtimeAtom({
        id: "atom-review-merge",
        label: "review-merge",
        verb: "review",
        object: "verified worker outputs",
        evidenceTarget: "final-report.md",
        doneCondition: "Worker outputs are reviewed and merged into a final result",
      })),
      rationale: "Synthesize the fanout output into the final operator-facing result",
    },
  };
}

function buildSecurityAuditNode(
  input: RoleSpecificDagPresetInput,
  dependsOn: string[],
): DagNodeDefinition {
  return {
    id: "security-audit",
    name: "Security audit and secret-safety review",
    role: "security",
    dependsOn,
    maxRetries: 1,
    outputs: [{ name: "security result", gate: "review-pass", ref: "security.md" }],
    failurePolicy: { retryable: true, blockDependents: true },
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "review", "security"],
      evidenceRequired: true,
      actionAtom: actionAtomRouting(runtimeAtom({
        id: "atom-security-audit",
        label: "security-audit",
        verb: "review",
        object: "security boundaries",
        evidenceTarget: "security.md",
        doneCondition: "Security-sensitive risks are reviewed before completion",
      })),
      rationale: "Security-sensitive DAGs require an explicit audit lane",
    },
  };
}

function buildDesignReviewNode(
  input: RoleSpecificDagPresetInput,
  dependsOn: string[],
): DagNodeDefinition {
  return {
    id: "design-review",
    name: "Design and TUI consistency review",
    role: "designer",
    dependsOn,
    maxRetries: 1,
    outputs: [{ name: "design result", gate: "summary", ref: "design-review.md" }],
    failurePolicy: { retryable: true, blockDependents: false },
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "review", "design"],
      evidenceRequired: true,
      actionAtom: actionAtomRouting(runtimeAtom({
        id: "atom-design-review",
        label: "design-review",
        verb: "review",
        object: "design and TUI consistency",
        evidenceTarget: "design-review.md",
        doneCondition: "UI and design constraints are checked when applicable",
      })),
      rationale: "Design/TUI work gets a dedicated review lane",
    },
  };
}

function buildLoopDecisionNode(
  input: RoleSpecificDagPresetInput,
  dependsOn: string[],
  evidenceRequired: boolean,
): DagNodeDefinition {
  return {
    id: "loop-decision",
    name: "Decide close continue replan or block",
    role: "orchestrator",
    dependsOn,
    maxRetries: 1,
    inputs: dependsOn.map((id) => ({ name: `${id} result`, ref: "state.json", from: id })),
    outputs: [{ name: "loop decision", gate: "summary", ref: "loop-state.json" }],
    routing: {
      ...baseRouting(input, true),
      assignedProviderCapabilities: ["read", "coordinate", "review"],
      evidenceRequired,
      actionAtom: actionAtomRouting(runtimeAtom({
        id: "atom-loop-decision",
        label: "loop-decision",
        verb: "coordinate",
        object: "next orchestration action",
        evidenceTarget: "loop-state.json",
        doneCondition: "Loop policy records close, continue, replan, verify-only, block, or handoff",
      })),
      rationale: "Every compiled run ends with a loop-policy decision surface",
    },
  };
}

function baseRouting(
  input: RoleSpecificDagPresetInput,
  readOnly: boolean,
): NonNullable<DagNodeDefinition["routing"]> {
  return {
    provider: input.providerPolicy,
    providerModel: input.input.model,
    contextBudget: input.intent.complexity === "complex" ? "normal" : "small",
    readOnly,
    risk: readOnly ? "read" : "write",
  };
}

function shouldRequireEvidence(intent: UserIntentV2): boolean {
  return Boolean(
    intent.routingHints.requireEvidence ||
      intent.routingHints.requireHarness ||
      intent.needsTesting ||
      intent.needsSecurityReview ||
      intent.needsDesignReview ||
      intent.targetSurfaces.includes("harness") ||
      intent.targetSurfaces.includes("tests") ||
      !intent.isReadOnly,
  );
}

function selectWorkerRoles(intent: UserIntentV2): string[] {
  const explicit = intent.requiredRoles.filter(
    (role) => !["planner", "orchestrator", "architect", "router"].includes(role),
  );
  if (explicit.length > 0) return uniqueStrings(explicit);
  const presets: Record<TaskType, string[]> = {
    explore: ["explorer"],
    implement: ["coder", "tester", "reviewer"],
    bugfix: ["debugger", "coder", "tester"],
    refactor: ["explorer", "coder", "qa"],
    research: ["researcher", "reviewer"],
    review: ["reviewer", "security", "qa"],
    plan: ["planner", "architect"],
    test: ["tester", "qa"],
    document: ["docs", "reviewer"],
    migrate: ["architect", "coder", "qa"],
    security: ["security", "coder", "qa"],
    general: ["coder", "reviewer"],
  };
  return presets[intent.taskType] ?? ["coder", "reviewer"];
}

function plannerRole(taskType: TaskType): string {
  if (taskType === "security") return "security";
  if (taskType === "migrate" || taskType === "plan") return "architect";
  return "planner";
}

function plannerName(taskType: TaskType): string {
  const names: Record<TaskType, string> = {
    explore: "Plan bounded repository exploration",
    implement: "Plan feature implementation lanes",
    bugfix: "Plan reproduce patch and regression lanes",
    refactor: "Plan impact analysis and refactor lanes",
    research: "Plan research and source verification lanes",
    review: "Plan review and audit lanes",
    plan: "Create architecture plan",
    test: "Plan test coverage and verification lanes",
    document: "Plan documentation update lanes",
    migrate: "Plan migration lanes",
    security: "Plan security audit and mitigation lanes",
    general: "Plan scoped multi-agent work",
  };
  return names[taskType] ?? "Plan scoped multi-agent work";
}

function readOnlyRole(taskType: TaskType): string {
  if (taskType === "research") return "researcher";
  if (taskType === "review") return "reviewer";
  return "explorer";
}

function readOnlyLaneName(taskType: TaskType): string {
  if (taskType === "research") return "Research requested context without edits";
  if (taskType === "review") return "Review requested scope without edits";
  return "Inspect requested scope without edits";
}

function workerTaskName(taskType: TaskType, index: number): string {
  const names: Record<TaskType, string> = {
    explore: `investigate area ${index}`,
    implement: `implement scoped change ${index}`,
    bugfix: `reproduce and patch defect ${index}`,
    refactor: `refactor scoped area ${index}`,
    research: `research source cluster ${index}`,
    review: `audit scope ${index}`,
    plan: `design lane ${index}`,
    test: `verify scenario ${index}`,
    document: `document section ${index}`,
    migrate: `migrate slice ${index}`,
    security: `audit and mitigate risk ${index}`,
    general: `execute scoped sub-task ${index}`,
  };
  return names[taskType] ?? `execute scoped sub-task ${index}`;
}

function verifierName(taskType: TaskType): string {
  if (taskType === "test") return "Run and summarize test evidence";
  if (taskType === "security") return "Verify security evidence";
  return "Verify worker evidence and quality gates";
}

function evidenceGate(intent: UserIntentV2): DagOutputGate {
  if (intent.needsTesting || intent.taskType === "test") return "test-pass";
  if (!intent.isReadOnly) return "command-pass";
  return "summary";
}

function firstAtom(frame: IntentFrame, fallbackVerb: ActionAtomVerb): ActionAtom {
  return frame.actionAtoms[0] ?? runtimeAtom({
    id: "atom-primary",
    label: "primary-action",
    verb: fallbackVerb,
    object: frame.problem,
    evidenceTarget: "summary.md",
    doneCondition: frame.desiredOutcome,
  });
}

function runtimeAtom(input: {
  id: string;
  label: string;
  verb: ActionAtomVerb;
  object: string;
  evidenceTarget: string;
  doneCondition: string;
}): ActionAtom {
  return makeActionAtom({ ...input, source: "runtime" });
}

function isReadOnlyRole(role: string): boolean {
  return ["explorer", "researcher", "reviewer", "qa", "tester", "security", "architect", "planner"].includes(role);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
