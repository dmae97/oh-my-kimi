/**
 * InteractiveOrchestrator — 대화형 병렬 서브에이전트 오케스트레이터
 *
 * Goal을 입력받아 병렬 서브에이전트를 소환하고,
 * 각 에이전트에게 skills, hooks, MCP를 부여하며 총 관리합니다.
 *
 * Pipeline:
 *   Goal → Decompose → Assign Capabilities → Confirm → Spawn Parallel → Monitor → Merge
 */

import { EventEmitter } from "events";
import type { DagNodeDefinition, DagNodeRouting } from "./dag.js";
import type { UserIntent } from "../contracts/orchestration.js";
import { assignSkills } from "./skill-assigner.js";
import {
  capabilityScopesFromRouting,
  mergeCapabilityScopes,
} from "./capability-routing.js";
import { analyzeUserIntent } from "../goal/intake.js";
import { buildIntentFrame } from "../goal/intent-frame.js";
import { ParallelOrchestrator } from "./parallel-orchestrator.js";
import { createDag, type Dag } from "./dag.js";
import { createRoutedRunState, routeRunState } from "./run-state.js";

// ─── Sub-Agent Spec ───────────────────────────────────────────────

export type SubAgentRole =
  | "coder"
  | "reviewer"
  | "tester"
  | "researcher"
  | "planner"
  | "explorer"
  | "security"
  | "architect"
  | "integrator"
  | "debugger";

export interface SubAgentSpec {
  /** 고유 에이전트 ID */
  readonly id: string;
  /** 에이전트 이름 (사람이 읽을 수 있는) */
  readonly name: string;
  /** 역할 */
  readonly role: SubAgentRole;
  /** 할당된 skills */
  readonly skills: readonly string[];
  /** 할당된 MCP servers */
  readonly mcpServers: readonly string[];
  /** 할당된 hooks */
  readonly hooks: readonly string[];
  /** 할당된 tools */
  readonly tools: readonly string[];
  /** 이 에이전트가 수행할 작업 설명 */
  readonly task: string;
  /** 의존하는 다른 에이전트 ID */
  readonly dependsOn: readonly string[];
  /** 타임아웃 (ms) */
  readonly timeoutMs?: number;
  /** 실패 시 재시도 횟수 */
  readonly maxRetries?: number;
  /** 실패 시 정책 */
  readonly failurePolicy?: "block" | "skip" | "warn";
  /** 읽기 전용 여부 */
  readonly readOnly?: boolean;
  /** provider 우선순위 */
  readonly provider?: string;
  /** 모델 지정 */
  readonly model?: string;
}

// ─── Goal Spec ────────────────────────────────────────────────────

export interface OrchestratorGoal {
  /** Goal 설명 */
  readonly description: string;
  /** 성공 기준 */
  readonly successCriteria?: readonly string[];
  /** 제약 조건 */
  readonly constraints?: readonly string[];
  /** 예상 산출물 */
  readonly expectedArtifacts?: readonly string[];
  /** 최대 워커 수 */
  readonly maxWorkers?: number;
  /** 타임아웃 (ms) */
  readonly timeoutMs?: number;
  /** 실행 전략 */
  readonly strategy?: "parallel" | "sequential" | "auto";
}

// ─── Orchestration State ──────────────────────────────────────────

export type OrchestrationPhase =
  | "analyzing"
  | "decomposing"
  | "assigning"
  | "confirming"
  | "spawning"
  | "running"
  | "merging"
  | "completed"
  | "failed";

export interface SubAgentState {
  readonly spec: SubAgentSpec;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  tokenUsage?: { input: number; output: number };
}

export interface InteractiveOrchestrationState {
  readonly goal: OrchestratorGoal;
  phase: OrchestrationPhase;
  readonly subAgents: SubAgentState[];
  readonly runId: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  progress: { completed: number; total: number; percentage: number };
}

// ─── Events ───────────────────────────────────────────────────────

export interface InteractiveOrchestratorEvents {
  phase: (phase: OrchestrationPhase) => void;
  subagent_spawned: (agent: SubAgentState) => void;
  subagent_completed: (agent: SubAgentState) => void;
  subagent_failed: (agent: SubAgentState) => void;
  progress: (state: InteractiveOrchestrationState) => void;
  log: (message: string, level: "info" | "warn" | "error") => void;
  confirm_required: (agents: readonly SubAgentSpec[]) => Promise<boolean>;
}

// ─── InteractiveOrchestrator ──────────────────────────────────────

export class InteractiveOrchestrator extends EventEmitter {
  private state: InteractiveOrchestrationState;
  private dag?: Dag;
  private orchestrator?: ParallelOrchestrator;

  constructor(
    private readonly goal: OrchestratorGoal,
    private readonly options: {
      readonly cwd?: string;
      readonly runId?: string;
      readonly autoConfirm?: boolean;
      readonly dryRun?: boolean;
      readonly onConfirm?: (agents: readonly SubAgentSpec[]) => Promise<boolean>;
    } = {}
  ) {
    super();
    const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.state = {
      goal,
      phase: "analyzing",
      subAgents: [],
      runId,
      startedAt: new Date().toISOString(),
      progress: { completed: 0, total: 0, percentage: 0 },
    };
  }

  // ─── Main Pipeline ──────────────────────────────────────────

  async execute(): Promise<InteractiveOrchestrationState> {
    try {
      // Phase 1: Analyze goal
      this.setPhase("analyzing");
      const intent = analyzeUserIntent(this.goal.description);
      this.emit("log", `Intent: ${intent.taskType} (complexity: ${intent.complexity})`, "info");

      // Phase 2: Decompose into sub-agents
      this.setPhase("decomposing");
      const specs = this.decomposeGoal(intent);
      this.emit("log", `Decomposed into ${specs.length} sub-agents`, "info");

      // Phase 3: Assign capabilities
      this.setPhase("assigning");
      const enrichedSpecs = this.assignCapabilities(specs, intent);
      this.state.subAgents.push(
        ...enrichedSpecs.map((spec) => ({
          spec,
          status: "pending" as const,
        }))
      );

      // Phase 4: Confirm with user
      this.setPhase("confirming");
      const confirmed = await this.confirmExecution(enrichedSpecs);
      if (!confirmed) {
        if (this.options.dryRun) {
          this.state.phase = "completed";
          this.state.completedAt = new Date().toISOString();
          this.emit("log", "Dry run completed without execution", "info");
          return this.state;
        }
        this.state.phase = "failed";
        this.state.error = "User cancelled orchestration";
        this.emit("log", "Orchestration cancelled by user", "warn");
        return this.state;
      }

      // Phase 5: Build DAG and spawn
      this.setPhase("spawning");
      this.dag = this.buildDag(enrichedSpecs, intent);
      this.emit("log", `Built DAG with ${this.dag.nodes.length} nodes`, "info");

      // Phase 6: Execute parallel
      this.setPhase("running");
      await this.executeParallel();

      // Phase 7: Merge results
      this.setPhase("merging");
      this.mergeResults();

      this.setPhase("completed");
      this.state.completedAt = new Date().toISOString();
      this.emit("log", "Orchestration completed successfully", "info");
    } catch (error) {
      this.state.phase = "failed";
      this.state.error = error instanceof Error ? error.message : String(error);
      this.state.completedAt = new Date().toISOString();
      this.emit("log", `Orchestration failed: ${this.state.error}`, "error");
    }

    return this.state;
  }

  // ─── Phase 2: Decompose Goal ────────────────────────────────

  private decomposeGoal(intent: UserIntent): SubAgentSpec[] {
    const { description, maxWorkers = 4 } = this.goal;
    const taskType = intent.taskType;
    const roles = intent.requiredRoles ?? this.defaultRoles(taskType);
    const workerCount = Math.min(
      Math.max(2, intent.estimatedWorkers ?? 2),
      maxWorkers
    );

    const specs: SubAgentSpec[] = [];
    const intentFrame = buildIntentFrame(description);
    const actionAtoms = intentFrame.actionAtoms;

    // Coordinator agent
    specs.push({
      id: "coordinator",
      name: `Coordinator (${taskType})`,
      role: "architect",
      skills: ["omk-plan-first", "omk-repo-explorer"],
      mcpServers: [],
      hooks: [],
      tools: [],
      task: `Coordinate and plan: ${description}`,
      dependsOn: [],
      timeoutMs: 60_000,
      maxRetries: 1,
      failurePolicy: "block",
      readOnly: true,
    });

    // Worker agents based on roles
    const workerRoles = roles.filter(
      (r) => r !== "planner" && r !== "orchestrator" && r !== "architect"
    );
    if (workerRoles.length === 0) workerRoles.push("coder");

    for (let i = 0; i < workerCount; i++) {
      const role = workerRoles[i % workerRoles.length];
      const atom = actionAtoms[(i + 1) % actionAtoms.length];
      const atomLabel = atom?.label ?? `task-${i + 1}`;

      specs.push({
        id: `worker-${i + 1}`,
        name: `Worker ${i + 1} (${role}): ${atomLabel}`,
        role: role as SubAgentRole,
        skills: this.defaultSkillsForRole(role),
        mcpServers: this.defaultMcpForRole(role),
        hooks: this.defaultHooksForRole(role),
        tools: this.defaultToolsForRole(role),
        task: atom?.verb
          ? `${atom.verb} ${atom.object} — ${atom.doneCondition}`
          : `Execute sub-task ${i + 1}: ${description}`,
        dependsOn: ["coordinator"],
        timeoutMs: 120_000,
        maxRetries: 1,
        failurePolicy: "skip",
      });
    }

    // Reviewer agent
    specs.push({
      id: "reviewer",
      name: "Reviewer: verify and merge outputs",
      role: "reviewer",
      skills: ["omk-code-review", "omk-quality-gate"],
      mcpServers: [],
      hooks: [],
      tools: [],
      task: `Review and verify all worker outputs for: ${description}`,
      dependsOn: specs.filter((s) => s.id.startsWith("worker-")).map((s) => s.id),
      timeoutMs: 60_000,
      maxRetries: 1,
      failurePolicy: "warn",
      readOnly: true,
    });

    return specs;
  }

  // ─── Phase 3: Assign Capabilities ───────────────────────────

  private assignCapabilities(
    specs: SubAgentSpec[],
    _intent: UserIntent
  ): SubAgentSpec[] {
    return specs.map((spec) => {
      // Use existing skill-assigner for additional capabilities
      const routing: DagNodeRouting = {
        skills: [...spec.skills],
        mcpServers: [...spec.mcpServers],
        hooks: [...spec.hooks],
        tools: [...spec.tools],
        provider: spec.provider,
        providerModel: spec.model,
      };

      // Merge with auto-detected capabilities
      const autoAssigned = assignSkills({
        id: spec.id,
        name: spec.name,
        role: spec.role,
        routing,
      });

      const mergedScopes = mergeCapabilityScopes(
        autoAssigned,
        capabilityScopesFromRouting(routing)
      );

      return {
        ...spec,
        skills: [...new Set([...spec.skills, ...mergedScopes.skills])],
        mcpServers: [...new Set([...spec.mcpServers, ...mergedScopes.mcpServers])],
        hooks: [...new Set([...spec.hooks, ...mergedScopes.hooks])],
        tools: [...new Set([...spec.tools, ...mergedScopes.tools])],
      };
    });
  }

  // ─── Phase 4: Confirm ───────────────────────────────────────

  private async confirmExecution(specs: readonly SubAgentSpec[]): Promise<boolean> {
    if (this.options.autoConfirm) return true;
    if (this.options.onConfirm) {
      return this.options.onConfirm(specs);
    }
    // Default: emit and wait for external confirmation
    return new Promise((resolve) => {
      this.emit("confirm_required", specs);
      // Auto-confirm after emit if no listener handles it
      setTimeout(() => resolve(true), 100);
    });
  }

  // ─── Phase 5: Build DAG ─────────────────────────────────────

  private buildDag(specs: SubAgentSpec[], _intent: UserIntent): Dag {
    const nodes: DagNodeDefinition[] = specs.map((spec) => ({
      id: spec.id,
      name: spec.name,
      role: spec.role,
      dependsOn: [...spec.dependsOn],
      maxRetries: spec.maxRetries ?? 1,
      timeoutMs: spec.timeoutMs,
      failurePolicy: {
        retryable: (spec.maxRetries ?? 1) > 0,
        blockDependents: spec.failurePolicy === "block",
        skipOnFailure: spec.failurePolicy === "skip",
      },
      inputs: spec.dependsOn.map((dep) => ({
        name: `${dep} output`,
        ref: "state.json",
        from: dep,
      })),
      outputs: [{ name: `${spec.id} output`, gate: "none" }],
      routing: {
        skills: [...spec.skills],
        mcpServers: [...spec.mcpServers],
        hooks: [...spec.hooks],
        tools: [...spec.tools],
        provider: spec.provider ?? "auto",
        providerModel: spec.model,
        readOnly: spec.readOnly ?? false,
        assignedProviderCapabilities: this.capabilitiesForRole(spec.role),
        actionAtom: {
          id: `atom-${spec.id}`,
          label: spec.id,
          verb: spec.role === "reviewer" ? "review" : spec.role === "researcher" ? "research" : "execute",
          object: spec.task.slice(0, 80),
          evidenceTarget: `${spec.id} output`,
          doneCondition: `Task completed: ${spec.task.slice(0, 60)}`,
          source: "runtime" as const,
        },
      },
    }));

    return createDag({ nodes });
  }

  // ─── Phase 6: Execute Parallel ──────────────────────────────

  private async executeParallel(): Promise<void> {
    if (!this.dag) throw new Error("DAG not built");

    const maxWorkers = this.goal.maxWorkers ?? 4;
    const timeout = this.goal.timeoutMs ?? 600_000;
    const runId = this.state.runId;

    // Create run state
    const runState = createRoutedRunState({
      runId,
      startedAt: this.state.startedAt,
      nodes: this.dag.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        role: n.role,
        dependsOn: n.dependsOn,
        maxRetries: n.maxRetries,
        timeoutMs: n.timeoutMs,
        failurePolicy: n.failurePolicy,
        inputs: n.inputs,
        outputs: n.outputs,
        routing: n.routing,
      })),
      workerCount: maxWorkers,
    });

    routeRunState(runState, maxWorkers);

    // Create and run orchestrator
    this.orchestrator = new ParallelOrchestrator({
      dag: this.dag,
      runId,
      maxWorkers,
      cwd: this.options.cwd ?? process.cwd(),
      timeout,
      onProgress: (state) => {
        this.state.progress = state.progress;
        this.emit("progress", this.state);

        // Update sub-agent states from worker states
        for (const worker of state.workers) {
          const subAgent = this.state.subAgents.find(
            (a) => a.spec.id === worker.nodeId
          );
          if (subAgent) {
            subAgent.status =
              worker.status === "completed"
                ? "done"
                : worker.status === "running"
                ? "running"
                : worker.status === "failed"
                ? "failed"
                : "pending";
          }
        }
      },
      onLog: (entry) => {
        const level =
          entry.level === "error"
            ? ("error" as const)
            : entry.level === "warn"
            ? ("warn" as const)
            : ("info" as const);
        this.emit("log", `[${entry.workerId}] ${entry.message}`, level);
      },
    });

    const result = await this.orchestrator.execute();

    // Update final states
    if (!result.success) {
      throw new Error(result.error ?? "Orchestration failed");
    }
  }

  // ─── Phase 7: Merge Results ─────────────────────────────────

  private mergeResults(): void {
    const completed = this.state.subAgents.filter(
      (a) => a.status === "done"
    ).length;
    const total = this.state.subAgents.length;
    this.state.progress = {
      completed,
      total,
      percentage: total > 0 ? (completed / total) * 100 : 0,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────

  private setPhase(phase: OrchestrationPhase): void {
    this.state.phase = phase;
    this.emit("phase", phase);
  }

  private defaultRoles(taskType: string): string[] {
    const roleMap: Record<string, string[]> = {
      implement: ["coder", "coder", "reviewer"],
      bugfix: ["debugger", "coder", "reviewer"],
      refactor: ["coder", "coder", "reviewer"],
      explore: ["researcher", "explorer", "reviewer"],
      review: ["reviewer", "reviewer", "aggregator"],
      test: ["tester", "coder", "reviewer"],
      plan: ["planner", "researcher", "architect"],
      migrate: ["coder", "coder", "integrator"],
      security: ["security", "coder", "reviewer"],
      document: ["researcher", "coder", "reviewer"],
      general: ["coder", "researcher", "reviewer"],
    };
    return roleMap[taskType] ?? roleMap.general;
  }

  private defaultSkillsForRole(role: string): string[] {
    const skillMap: Record<string, string[]> = {
      coder: ["omk-plan-first", "karpathy-guidelines"],
      reviewer: ["omk-code-review", "omk-quality-gate"],
      tester: ["omk-test-debug-loop", "omk-quality-gate"],
      researcher: ["omk-repo-explorer", "omk-context-broker"],
      planner: ["omk-plan-first", "omk-repo-explorer"],
      explorer: ["omk-repo-explorer", "omk-context-broker"],
      security: ["omk-security-review", "omk-secret-guard"],
      architect: ["omk-plan-first", "omk-repo-explorer"],
      integrator: ["omk-quality-gate", "omk-git-commit-pr"],
      debugger: ["omk-test-debug-loop", "omk-troubleshooting"],
    };
    return skillMap[role] ?? skillMap.coder;
  }

  private defaultMcpForRole(role: string): string[] {
    const mcpMap: Record<string, string[]> = {
      coder: [],
      reviewer: [],
      tester: [],
      researcher: ["context7"],
      planner: [],
      explorer: ["context7"],
      security: [],
      architect: [],
      integrator: [],
      debugger: [],
    };
    return mcpMap[role] ?? [];
  }

  private defaultHooksForRole(_role: string): string[] {
    return []; // Hooks are project-specific, assigned via skill-assigner
  }

  private defaultToolsForRole(role: string): string[] {
    const toolMap: Record<string, string[]> = {
      coder: ["read", "write", "edit", "bash"],
      reviewer: ["read", "bash"],
      tester: ["read", "bash"],
      researcher: ["read", "grep", "glob"],
      planner: ["read", "grep", "glob"],
      explorer: ["read", "grep", "glob"],
      security: ["read", "grep", "bash"],
      architect: ["read", "grep", "glob"],
      integrator: ["read", "write", "bash"],
      debugger: ["read", "bash", "grep"],
    };
    return toolMap[role] ?? toolMap.coder;
  }

  private capabilitiesForRole(role: string): string[] {
    const capMap: Record<string, string[]> = {
      coder: ["write", "shell", "mcp"],
      reviewer: ["read", "review", "advisory"],
      tester: ["read", "shell", "review"],
      researcher: ["read", "advisory"],
      planner: ["read", "plan", "advisory"],
      explorer: ["read", "advisory"],
      security: ["read", "review", "shell"],
      architect: ["read", "plan", "write"],
      integrator: ["read", "write", "shell", "merge"],
      debugger: ["read", "shell", "write"],
    };
    return capMap[role] ?? capMap.coder;
  }

  // ─── Public Accessors ───────────────────────────────────────

  getState(): Readonly<InteractiveOrchestrationState> {
    return { ...this.state };
  }

  getSubAgents(): readonly SubAgentState[] {
    return [...this.state.subAgents];
  }

  getPhase(): OrchestrationPhase {
    return this.state.phase;
  }
}

// ─── Factory ──────────────────────────────────────────────────────

export function createInteractiveOrchestrator(
  goal: OrchestratorGoal,
  options?: {
    readonly cwd?: string;
    readonly runId?: string;
    readonly autoConfirm?: boolean;
    readonly dryRun?: boolean;
    readonly onConfirm?: (agents: readonly SubAgentSpec[]) => Promise<boolean>;
  }
): InteractiveOrchestrator {
  return new InteractiveOrchestrator(goal, options);
}

// ─── Utility: Format for display ──────────────────────────────────

export function formatSubAgentPlan(specs: readonly SubAgentSpec[]): string {
  const lines: string[] = [
    "# Parallel Sub-Agent Plan\n",
    `Total agents: ${specs.length}\n`,
    "",
    "| ID | Role | Skills | MCP | Hooks | Task |",
    "|----|------|--------|-----|-------|------|",
  ];

  for (const spec of specs) {
    lines.push(
      `| ${spec.id} | ${spec.role} | ${spec.skills.join(", ") || "—"} | ${spec.mcpServers.join(", ") || "—"} | ${spec.hooks.join(", ") || "—"} | ${spec.task.slice(0, 50)} |`
    );
  }

  lines.push("");
  lines.push("## Dependency Graph\n");
  lines.push("```mermaid");
  lines.push("graph TD");

  for (const spec of specs) {
    if (spec.dependsOn.length === 0) {
      lines.push(`  ${spec.id}[${spec.name}]`);
    } else {
      for (const dep of spec.dependsOn) {
        lines.push(`  ${dep} --> ${spec.id}[${spec.name}]`);
      }
    }
  }

  lines.push("```");
  return lines.join("\n");
}
