/**
 * ParallelOrchestrator — 병렬 에이전트 오케스트레이션 핵심 로직
 *
 * ExecutionPlanner, StateManager, LogStreamer, AgentWorker를 통합하여
 * DAG 기반 병렬 실행을 관리합니다.
 */

import { join } from "path";
import type { Dag, DagNode } from "./dag.js";
import type { RunCapabilityAssignment } from "../contracts/orchestration.js";
// TaskResult removed — unused in this file
import {
  createExecutionPlan,
  formatExecutionPlan,
  getNextExecutableBatch,
  type ExecutionPlan,
} from "./execution-planner.js";
import {
  OrchestrationStateManager,
  type OrchestrationEvent,
  type WorkerState,
} from "./orchestration-state.js";
import { LogStreamer, type LogEntry, type WorkerLogHandle } from "./log-streamer.js";
import { AgentWorker, createAgentWorker, type WorkerOutput } from "./agent-worker.js";
import { createRuntimeRouter } from "../runtime/runtime-router.js";
import { classifyIntent } from "../cli/runtime/intent-classifier.js";
import { selectCapabilities } from "../cli/runtime/capability-selector.js";
import { createSubAgentSidecar } from "../cli/runtime/runtime-sidecar.js";
import type { CapabilityPlan, RuntimeSidecar } from "../cli/runtime/types.js";
import type { ContextCapsule } from "../runtime/context-capsule.js";
import { buildCapabilityInjection, applyCapabilityInjectionToRouting } from "../runtime/capability-injection.js";
import { capabilityScopesFromRouting, mergeCapabilityScopes, type NodeCapabilityScopes } from "./capability-routing.js";
import { assignSkills } from "./skill-assigner.js";
import { dagNodeRoutingEnv } from "./routing.js";
import { buildTaskRunContext, envFromWorkerManifest } from "../runtime/worker-manifest.js";
import type { TaskRunContext, WorkerManifest } from "../contracts/worker-context.js";

import { checkEvidenceGates, type EvidenceGate, type EvidenceResult } from "./evidence-gate.js";

export interface ParallelOrchestratorOptions {
  dag: Dag;
  runId: string;
  goalId?: string;
  objective?: string;
  maxWorkers: number;
  cwd?: string;
  timeout?: number;
  onProgress?: (state: ParallelOrchestrationState) => void;
  onLog?: (entry: LogEntry) => void;
}

export interface ParallelOrchestrationState {
  runId: string;
  status: "initializing" | "running" | "paused" | "completed" | "failed" | "cancelled";
  progress: {
    completed: number;
    total: number;
    percentage: number;
  };
  workers: WorkerState[];
  nodeRuntimes?: Record<string, string>;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface ParallelOrchestrationResult {
  success: boolean;
  state: ParallelOrchestrationState;
  executionPlan: ExecutionPlan;
  events: OrchestrationEvent[];
  error?: string;
}

export interface ParallelWorkerCapabilityContext {
  readonly node: DagNode;
  readonly scopes: NodeCapabilityScopes;
  readonly assignment: RunCapabilityAssignment;
  readonly env: Record<string, string>;
  readonly workerManifest: WorkerManifest;
  readonly runContext: TaskRunContext;
}

export function buildParallelWorkerCapabilityContext(
  node: DagNode,
  dag?: Dag,
  options: {
    readonly runId?: string;
    readonly root?: string;
    readonly goalId?: string;
    readonly objective?: string;
  } = {}
): ParallelWorkerCapabilityContext {
  const assigned = assignSkills(node);
  const scopes = mergeCapabilityScopes(assigned, capabilityScopesFromRouting(node.routing));
  const injection = buildCapabilityInjection({
    mcpServers: scopes.mcpServers,
    skills: scopes.skills,
    tools: scopes.tools,
    hooks: scopes.hooks,
    requireMcp: node.routing?.requiresMcp,
    requiresToolCalling: node.routing?.requiresToolCalling ?? scopes.tools.length > 0,
  });
  const routedNode: DagNode = {
    ...node,
    routing: applyCapabilityInjectionToRouting(node.routing ?? {}, injection),
  };
  const runContext = buildTaskRunContext({
    runId: options.runId ?? "local-parallel",
    ...(options.goalId ? { goalId: options.goalId } : {}),
    root: options.root ?? process.cwd(),
    node: routedNode,
    objective: options.objective ?? routedNode.name,
    toolPlane: {
      mcpServers: scopes.mcpServers,
      skills: scopes.skills,
      hooks: scopes.hooks,
      tools: scopes.tools,
      requiresRuntimeMcp: routedNode.routing?.requiresMcp,
    },
  });
  return {
    node: routedNode,
    scopes,
    assignment: {
      skills: [...scopes.skills],
      mcpServers: [...scopes.mcpServers],
      hooks: [...scopes.hooks],
      ...(scopes.tools.length > 0 ? { tools: [...scopes.tools] } : {}),
      source: "skill-assigner",
      rationale: injection.summary.rationale,
    },
    env: {
      ...dagNodeRoutingEnv(routedNode, dag),
      OMK_NODE_CAPABILITY_SUMMARY: injection.summary.rationale,
    },
    workerManifest: runContext.worker,
    runContext,
  };
}

export function buildParallelWorkerEnv(
  capabilityContext: ParallelWorkerCapabilityContext,
  providerPolicy?: unknown,
  capabilities?: unknown
): Record<string, string> {
  const workerEnv: Record<string, string> = {
    ...envFromWorkerManifest(capabilityContext.workerManifest),
    ...capabilityContext.env,
  };
  if (providerPolicy) {
    workerEnv.OMK_NODE_PROVIDER_POLICY = JSON.stringify(providerPolicy);
  }
  if (capabilities) {
    workerEnv.OMK_NODE_CAPABILITIES = JSON.stringify(capabilities);
  }
  return workerEnv;
}

export class ParallelOrchestrator {
  private dag: Dag;
  private runId: string;
  private goalId?: string;
  private objective?: string;
  private maxWorkers: number;
  private cwd: string;
  private timeout: number;
  private executionPlan: ExecutionPlan;
  private stateManager: OrchestrationStateManager;
  private logStreamer: LogStreamer;
  private activeWorkers: Map<string, AgentWorker> = new Map();
  private completedNodes: Set<string> = new Set();
  private failedNodes: Set<string> = new Set();
  private nodeRuntimeMap: Map<string, string> = new Map();
  private onProgress?: (state: ParallelOrchestrationState) => void;
  private onLog?: (entry: LogEntry) => void;
  private abortController: AbortController | null = null;
  private runtimeRouter: ReturnType<typeof createRuntimeRouter>;
  private adaptiveMaxWorkers: number;
  private consecutiveFailures: number = 0;
  private lastBatchCompletedAt: number = 0;

  constructor(options: ParallelOrchestratorOptions) {
    this.dag = options.dag;
    this.runId = options.runId;
    this.goalId = options.goalId;
    this.objective = options.objective;
    this.maxWorkers = options.maxWorkers;
    this.cwd = options.cwd ?? process.cwd();
    this.timeout = options.timeout ?? 600000; // 10분 기본
    this.onProgress = options.onProgress;
    this.onLog = options.onLog;

    // 실행 계획 생성
    this.executionPlan = createExecutionPlan({
      dag: this.dag.nodes,
      maxWorkers: this.maxWorkers,
    });

    // 상태 관리자 초기화
    this.stateManager = new OrchestrationStateManager({
      runId: this.runId,
      nodes: this.dag.nodes,
      workerCount: this.maxWorkers,
      basePath: this.cwd,
    });

    // 로그 스트리머 초기화
    this.logStreamer = new LogStreamer({
      logDir: join(this.cwd, ".omk/logs"),
    });
    if (this.onLog) {
      this.logStreamer.onLog(this.onLog);
    }

    this.runtimeRouter = createRuntimeRouter();
    this.adaptiveMaxWorkers = options.maxWorkers;
  }

  /**
   * 오케스트레이션 실행
   */
  async execute(): Promise<ParallelOrchestrationResult> {
    this.abortController = new AbortController();

    try {
      // 초기화
      await this.initialize();

      // 상태 업데이트: 실행 중
      this.stateManager.setStatus("running");
      this.emitProgress();

      // 실행 계획 로깅
      this.logStreamer.log("info", `Execution plan:\n${formatExecutionPlan(this.executionPlan)}`);

      // 메인 실행 루프
      await this.executeLoop();

      // 완료 확인
      const success = this.verifyCompletion();

      // 상태 업데이트: 완료
      this.stateManager.setStatus(success ? "completed" : "failed");
      this.stateManager.setCompletedAt(new Date().toISOString());

      // 결과 반환
      return this.createResult(success);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logStreamer.log("error", `Orchestration failed: ${message}`);
      this.stateManager.setStatus("failed");
      this.stateManager.setError(message);

      return this.createResult(false, message);
    } finally {
      // 정리
      await this.cleanup();
    }
  }

  /**
   * 오케스트레이션 중단
   */
  async abort(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }

    // 모든 활성 워커 중단
    for (const [nodeId, worker] of this.activeWorkers.entries()) {
      this.logStreamer.log("warn", `Aborting worker: ${nodeId}`);
      worker.abort();
    }

    this.stateManager.setStatus("cancelled");
    this.logStreamer.log("warn", "Orchestration aborted");
  }

  /**
   * 초기화
   */
  private async initialize(): Promise<void> {
    this.logStreamer.log("info", "Initializing orchestrator...");

    // 상태 관리자 초기화
    this.stateManager.initialize();

    // 로그 스트리머 초기화
    await this.logStreamer.initialize();

    // DAG 노드 상태 초기화
    for (const node of this.dag.nodes) {
      this.stateManager.initializeWorker(node.id, node.maxRetries ?? 3);
    }

    this.logStreamer.log("info", `Initialized ${this.dag.nodes.length} workers`);
  }

  /**
   * 메인 실행 루프
   */
  private async executeLoop(): Promise<void> {
    while (!this.isComplete() && !this.isAborted()) {
      // 다음 실행 가능한 배치 찾기
      const batch = getNextExecutableBatch(this.executionPlan, this.completedNodes);

      if (!batch) {
        // 실행할 배치가 없으면 대기
        await this.waitForCompletion();
        continue;
      }

      // 배치 실행
      await this.executeBatch(batch);

      // 진행 상황 업데이트
      this.emitProgress();

      // 완료 확인
      if (this.isComplete()) {
        break;
      }

      // 잠시 대기 (CPU 부하 방지)
      await this.sleep(100);
    }
  }

  /**
   * 배치 실행
   */
  private async executeBatch(batch: DagNode[]): Promise<void> {
    // Adaptive pool sizing
    if (this.consecutiveFailures >= 3 && this.adaptiveMaxWorkers > 1) {
      this.adaptiveMaxWorkers = Math.max(1, this.adaptiveMaxWorkers - 1);
      this.logStreamer.log("warn", `Reducing worker pool to ${this.adaptiveMaxWorkers} due to consecutive failures`);
    }
    if (this.consecutiveFailures === 0 && this.adaptiveMaxWorkers < this.maxWorkers) {
      this.adaptiveMaxWorkers++;
      this.logStreamer.log("info", `Increasing worker pool to ${this.adaptiveMaxWorkers}`);
    }

    const cappedBatch = batch.slice(0, this.adaptiveMaxWorkers);

    this.logStreamer.log(
      "info",
      `Executing batch: ${cappedBatch.map((n) => n.id).join(", ")}`
    );

    // 병렬로 모든 워커 시작
    const workerPromises = cappedBatch.map((node) => this.executeWorker(node));

    // 모든 워커 완료 대기
    await Promise.all(workerPromises);

    this.logStreamer.log(
      "info",
      `Batch completed: ${cappedBatch.map((n) => n.id).join(", ")}`
    );
  }

  /**
   * 노드에 대한 CapabilityPlan 생성
   * IntentClassifier + CapabilitySelector를 사용하여 per-node capabilities 결정
   */
  private buildCapabilityPlanForNode(node: DagNode): CapabilityPlan {
    const intent = classifyIntent(node.name, node.role);
    const plan = selectCapabilities(intent, undefined, node.role);
    this.logStreamer.log("info", `Node ${node.id}: intent=${intent.kind} (conf=${intent.confidence.toFixed(2)}), skills=[${plan.skills.join(",")}], mcp=[${plan.mcpServers.join(",")}]`);
    return plan;
  }

  /**
   * 노드에 대한 RuntimeSidecar 생성
   * CapabilityPlan을 기반으로 필터링된 런타임 컨텍스트 생성
   */
  private buildSidecarForNode(node: DagNode): RuntimeSidecar {
    const plan = this.buildCapabilityPlanForNode(node);
    return createSubAgentSidecar(plan, node.name);
  }


  /**
   * 개별 워커 실행
   */
  private async executeWorker(node: DagNode): Promise<void> {
    const logHandle = this.logStreamer.createWorkerHandle(node.id);
    let workerNode = node;

    try {
      const capabilityContext = buildParallelWorkerCapabilityContext(node, this.dag, {
        runId: this.runId,
        root: this.cwd,
        goalId: this.goalId,
        objective: this.objective,
      });
      workerNode = capabilityContext.node;

      // Intent classification + runtime routing
      const capsule = {
        nodeId: workerNode.id,
        goal: workerNode.name,
        task: workerNode.name,
        system: "",
        node: workerNode,
      } as unknown as ContextCapsule;

      const intent = this.runtimeRouter.classifyIntent(capsule);
      let selectedRuntime = "runtime-backed";
      try {
        selectedRuntime = this.runtimeRouter.select(capsule).runtime.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logStreamer.log("warn", `Runtime preselection deferred for ${workerNode.id}: ${message}`);
      }
      this.logStreamer.log("info", `Node ${workerNode.id} classified as intent: ${intent}, selected runtime: ${selectedRuntime}`);
      this.nodeRuntimeMap.set(workerNode.id, selectedRuntime);

      // Derive per-node ProviderPolicy and CapabilityManifest from execution plan
      const nodeMeta = this.executionPlan.nodeMeta.get(workerNode.id);
      const providerPolicy = nodeMeta?.providerPolicy;
      const capabilities = nodeMeta?.capabilities;
      const workerRunContext = buildTaskRunContext({
        runId: this.runId,
        ...(this.goalId ? { goalId: this.goalId } : {}),
        root: this.cwd,
        node: workerNode,
        objective: this.objective ?? workerNode.name,
        toolPlane: {
          mcpServers: capabilityContext.scopes.mcpServers,
          skills: capabilityContext.scopes.skills,
          hooks: capabilityContext.scopes.hooks,
          tools: capabilityContext.scopes.tools,
          requiresRuntimeMcp: workerNode.routing?.requiresMcp,
        },
        providerPolicy,
        capabilities,
        selectedRuntimeId: selectedRuntime,
      });

      // Build worker env with only scoped policy/capability metadata.
      const workerEnv = {
        ...buildParallelWorkerEnv(capabilityContext, providerPolicy, capabilities),
        ...envFromWorkerManifest(workerRunContext.worker),
      };

      // 워커 상태 업데이트: 실행 중
      this.stateManager.startWorker(workerNode.id, capabilityContext.assignment);
      this.stateManager.emitEvent({
        type: "worker_started",
        nodeId: workerNode.id,
        timestamp: new Date().toISOString(),
        data: {
          intent,
          selectedRuntime,
          providerPolicy,
          capabilities,
          capabilityScopes: capabilityContext.scopes,
        },
      });

      // 워커 생성
      // TODO: Update AgentWorker/AgentWorkerOptions to accept providerPolicy and capabilities natively
      const worker = await createAgentWorker(workerNode, this.runId, logHandle, {
        cwd: this.cwd,
        env: workerEnv,
        runContext: workerRunContext,
      });

      this.activeWorkers.set(workerNode.id, worker);

      // 워커 실행
      const output = await worker.execute();

      // 결과 처리
      await this.handleWorkerResult(workerNode, output, logHandle);

      // 활성 워커 목록에서 제거
      this.activeWorkers.delete(workerNode.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logHandle.log("error", `Worker failed: ${message}`);

      // 실패 처리
      await this.handleWorkerFailure(workerNode, message, logHandle);

      // 활성 워커 목록에서 제거
      this.activeWorkers.delete(workerNode.id);
    } finally {
      logHandle.close();
    }
  }

  /**
   * 워커 결과 처리
   */
  private async handleWorkerResult(node: DagNode, output: WorkerOutput, logHandle: WorkerLogHandle): Promise<void> {
    if (output.success) {
      logHandle.log("info", `Worker succeeded (exit code: ${output.exitCode})`);

      // Evidence gate check
      const evidenceGates = (node as DagNode & { evidenceGates?: EvidenceGate[] }).evidenceGates;
      if (evidenceGates && evidenceGates.length > 0) {
        const gateResult = await checkEvidenceGates(evidenceGates, {
          cwd: this.cwd,
          stdout: output.stdout,
          nodeId: node.id,
          runId: this.runId,
        });
        if (!gateResult.passed) {
          this.logStreamer.log("error", `Evidence gate failed for ${node.id}: ${gateResult.evidence.map((e: EvidenceResult) => e.message).join("; ")}`);
          // Treat as failure for node completion
          this.stateManager.failWorker(node.id, `Evidence gate failed: ${gateResult.evidence.filter((e: EvidenceResult) => !e.passed).map((e: EvidenceResult) => e.message).join("; ")}`);
          this.failedNodes.add(node.id);
          this.consecutiveFailures++;
          return;
        }
      }

      this.consecutiveFailures = 0; // reset on success

      // 완료 처리
      this.completedNodes.add(node.id);
      this.stateManager.completeWorker(node.id, output);
      const selectedRuntime = this.nodeRuntimeMap.get(node.id);
      this.stateManager.emitEvent({
        type: "worker_completed",
        nodeId: node.id,
        timestamp: new Date().toISOString(),
        data: { success: true, exitCode: output.exitCode, selectedRuntime },
      });

      // Integration lane (optional hook point)
      if (node.routing?.needsIntegration) {
        this.logStreamer.log("info", `Integration lane required for ${node.id}`);
        // Integration is a placeholder; actual implementation would spawn an integrator worker
        // For now, just log and continue
      }
    } else {
      logHandle.log(
        "error",
        `Worker failed (exit code: ${output.exitCode}): ${output.stderr}`
      );

      // 실패 처리
      await this.handleWorkerFailure(node, `Exit code: ${output.exitCode}\n${output.stderr}`, logHandle);
    }
  }

  /**
   * 워커 실패 처리 (재시도 로직 포함)
   */
  private async handleWorkerFailure(node: DagNode, error: string, logHandle: WorkerLogHandle): Promise<void> {
    const worker = this.stateManager.getWorker(node.id);
    const retryCount = worker?.retryCount ?? 0;
    const maxRetries = node.maxRetries ?? 3;

    // Retry with exponential backoff
    const canRetry = this.stateManager.retryWorker(node.id);
    if (canRetry && worker) {
      const backoffMs = Math.min(30000, 1000 * Math.pow(2, worker.retryCount));
      this.logStreamer.log("warn", `Retrying node ${node.id} in ${backoffMs}ms (attempt ${worker.retryCount}/${maxRetries})`);
      await this.sleep(backoffMs);
      this.stateManager.emitEvent({
        type: "worker_retrying",
        nodeId: node.id,
        timestamp: new Date().toISOString(),
        data: { retryCount: worker.retryCount, maxRetries },
      });
      // Re-queue the node by removing from failed set
      this.failedNodes.delete(node.id);
      return; // Worker will be re-picked in next batch
    }

    // 최종 실패
    logHandle.log(
      "error",
      `Worker failed after ${maxRetries} retries`
    );

    this.failedNodes.add(node.id);
    this.stateManager.failWorker(node.id, error);
    const selectedRuntime = this.nodeRuntimeMap.get(node.id);
    this.stateManager.emitEvent({
      type: "worker_failed",
      nodeId: node.id,
      timestamp: new Date().toISOString(),
      data: { error, retryCount, maxRetries, selectedRuntime },
    });
    this.consecutiveFailures++;
  }

  /**
   * 모든 워커 완료 대기
   */
  private async waitForCompletion(): Promise<void> {
    if (this.activeWorkers.size === 0) {
      return;
    }

    // 활성 워커 중 하나가 완료될 때까지 대기
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.activeWorkers.size === 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * 오케스트레이션 완료 확인
   */
  private isComplete(): boolean {
    const totalNodes = this.dag.nodes.length;
    const completedOrFailed = this.completedNodes.size + this.failedNodes.size;

    return completedOrFailed >= totalNodes;
  }

  /**
   * 중단 여부 확인
   */
  private isAborted(): boolean {
    return this.abortController?.signal.aborted ?? false;
  }

  /**
   * 완료 검증
   */
  private verifyCompletion(): boolean {
    // 모든 노드가 완료되었는지 확인
    for (const node of this.dag.nodes) {
      if (!this.completedNodes.has(node.id)) {
        this.logStreamer.log(
          "error",
          `Node ${node.id} did not complete`
        );
        return false;
      }
    }

    this.logStreamer.log("info", "All nodes completed successfully");
    return true;
  }

  /**
   * 진행 상황 이벤트 발생
   */
  private emitProgress(): void {
    if (!this.onProgress) return;

    const state: ParallelOrchestrationState = {
      runId: this.runId,
      status: this.stateManager.getStatus(),
      progress: {
        completed: this.completedNodes.size,
        total: this.dag.nodes.length,
        percentage: (this.completedNodes.size / this.dag.nodes.length) * 100,
      },
      workers: this.stateManager.getAllWorkers(),
      nodeRuntimes: Object.fromEntries(this.nodeRuntimeMap),
      startedAt: this.stateManager.getStartedAt(),
      completedAt: this.stateManager.getCompletedAt(),
      error: this.stateManager.getError(),
    };

    this.onProgress(state);
  }

  /**
   * 결과 생성
   */
  private createResult(success: boolean, error?: string): ParallelOrchestrationResult {
    return {
      success,
      state: {
        runId: this.runId,
        status: this.stateManager.getStatus(),
        progress: {
          completed: this.completedNodes.size,
          total: this.dag.nodes.length,
          percentage: (this.completedNodes.size / this.dag.nodes.length) * 100,
        },
        workers: this.stateManager.getAllWorkers(),
        nodeRuntimes: Object.fromEntries(this.nodeRuntimeMap),
        startedAt: this.stateManager.getStartedAt(),
        completedAt: this.stateManager.getCompletedAt(),
        error: error ?? this.stateManager.getError(),
      },
      executionPlan: this.executionPlan,
      events: this.stateManager.getEvents(),
      error,
    };
  }

  /**
   * 정리
   */
  private async cleanup(): Promise<void> {
    // 모든 활성 워커 정리
    for (const worker of this.activeWorkers.values()) {
      worker.abort();
    }
    this.activeWorkers.clear();

    // 상태 저장
    await this.stateManager.save();

    // 로그 스트리머 종료
    await this.logStreamer.close();

    this.logStreamer.log("info", "Orchestrator cleanup complete");
  }

  /**
   * Sleep 헬퍼
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
