/**
 * OrchestrationStateManager — 병렬 오케스트레이션 상태 관리
 *
 * Refactored to use pure state-transition functions.
 * Original mutable implementation extracted into run-state-machine.ts and node-state-machine.ts.
 */

import type { RunState, TaskResult } from "../../contracts/orchestration.js";
import type { DagNode } from "../dag.js";
import { createStatePersister, type StatePersister } from "../state-persister.js";
import { assignNodeCapabilitiesToRunState, createRoutedRunState } from "../run-state.js";
import type { OrchestrationEvent, OrchestrationState, StateManagerOptions, WorkerState } from "../contracts/index.js";
import { transitionWorker, getRunningWorkerCount, getCompletedWorkerCount, getFailedWorkerCount } from "./run-state-machine.js";
import { transitionNode } from "./node-state-machine.js";

function updateNodeInRunState(runState: RunState, nodeId: string, updater: (node: DagNode) => DagNode): RunState {
  return {
    ...runState,
    nodes: runState.nodes.map((n) => (n.id === nodeId ? updater(n) : n)),
  };
}

export class OrchestrationStateManager {
  private state: OrchestrationState;
  private persister: StatePersister;
  private runState: RunState;
  private orchestrationError?: string;

  constructor(options: StateManagerOptions) {
    this.persister = createStatePersister(options.basePath ?? ".omk/runs");

    this.state = {
      runId: options.runId,
      status: "initializing",
      workers: new Map(),
      events: [],
      completedNodes: new Set(),
      startedAt: new Date().toISOString(),
    };

    this.runState = createRoutedRunState({
      runId: options.runId,
      startedAt: this.state.startedAt,
      nodes: options.nodes,
      workerCount: options.workerCount,
      goalId: options.goalId,
      goalSnapshot: options.goalSnapshot,
    });
  }

  /**
   * 워커 상태 초기화
   */
  initializeWorker(nodeId: string, maxRetries: number): void {
    this.state = transitionWorker(this.state, { type: "initialize", nodeId, maxRetries });
  }

  /**
   * 워커 시작
   */
  startWorker(nodeId: string, assignment?: WorkerState["assignment"]): void {
    const startedAt = new Date().toISOString();
    this.state = transitionWorker(this.state, { type: "start", nodeId, assignment });

    // RunState의 노드 상태 업데이트
    this.runState = assignNodeCapabilitiesToRunState({
      ...updateNodeInRunState(this.runState, nodeId, (node) =>
        transitionNode(node, { type: "start", startedAt })
      ),
      ...(assignment ? {
        capabilityAssignments: {
          ...(this.runState.capabilityAssignments ?? {}),
          [nodeId]: assignment,
        },
      } : {}),
    });
  }

  /**
   * 워커 완료
   */
  completeWorker(nodeId: string, result: TaskResult): void {
    const worker = this.state.workers.get(nodeId);
    if (!worker) throw new Error(`Worker ${nodeId} not found`);

    const completedAt = new Date().toISOString();
    const durationMs = worker.startedAt
      ? new Date(completedAt).getTime() - new Date(worker.startedAt).getTime()
      : 0;

    this.state = transitionWorker(this.state, { type: "complete", nodeId, result });

    // RunState의 노드 상태 업데이트
    this.runState = updateNodeInRunState(this.runState, nodeId, (node) =>
      transitionNode(node, {
        type: "complete",
        completedAt,
        durationMs,
        success: result.success,
        retries: worker.retryCount,
      })
    );
  }

  /**
   * 워커 재시도
   */
  retryWorker(nodeId: string): boolean {
    const worker = this.state.workers.get(nodeId);
    if (!worker) throw new Error(`Worker ${nodeId} not found`);

    if (worker.retryCount >= worker.maxRetries) {
      return false;
    }

    this.state = transitionWorker(this.state, { type: "retry", nodeId });

    // RunState의 노드 상태 업데이트
    this.runState = updateNodeInRunState(this.runState, nodeId, (node) =>
      transitionNode(node, { type: "retry", retries: worker.retryCount + 1 })
    );

    return true;
  }

  /**
   * 워커 실패 (재시도 불가)
   */
  failWorker(nodeId: string, error: string): void {
    const completedAt = new Date().toISOString();
    this.state = transitionWorker(this.state, { type: "fail", nodeId, error });

    // RunState의 노드 상태 업데이트
    this.runState = updateNodeInRunState(this.runState, nodeId, (node) =>
      transitionNode(node, { type: "fail", completedAt })
    );
  }

  /**
   * 배치 완료
   */
  completeBatch(batchIndex: number, nodeIds: string[]): void {
    this.state = transitionWorker(this.state, { type: "batch_complete", batchIndex, nodeIds });
  }

  /**
   * 오케스트레이션 완료
   */
  complete(success: boolean): void {
    const completedAt = new Date().toISOString();
    this.state = transitionWorker(this.state, { type: "orchestration_complete", success });
    this.runState = { ...this.runState, completedAt };
  }

  /**
   * 워커 상태 조회
   */
  getWorker(nodeId: string): WorkerState | undefined {
    return this.state.workers.get(nodeId);
  }

  /**
   * 모든 워커 상태 조회
   */
  getAllWorkers(): WorkerState[] {
    return Array.from(this.state.workers.values());
  }

  /**
   * 실행 중인 워커 수
   */
  getRunningWorkerCount(): number {
    return getRunningWorkerCount(this.state);
  }

  /**
   * 완료된 워커 수
   */
  getCompletedWorkerCount(): number {
    return getCompletedWorkerCount(this.state);
  }

  /**
   * 실패한 워커 수
   */
  getFailedWorkerCount(): number {
    return getFailedWorkerCount(this.state);
  }

  /**
   * 이벤트 조회
   */
  getEvents(): OrchestrationEvent[] {
    return [...this.state.events];
  }

  /**
   * RunState 조회
   */
  getRunState(): RunState {
    return { ...this.runState };
  }

  /**
   * 상태 저장
   */
  async save(): Promise<void> {
    await this.persister.save(this.runState);
  }

  /**
   * 상태 로드
   */
  async load(): Promise<boolean> {
    const loaded = await this.persister.load(this.state.runId);
    if (loaded) {
      this.runState = loaded;
      // 워커 상태 복원
      const workers = new Map<string, WorkerState>();
      const completedNodes = new Set<string>();

      for (const node of loaded.nodes) {
        const status: WorkerState["status"] =
          node.status === "done"
            ? "completed"
            : node.status === "failed"
              ? "failed"
              : node.status === "running"
                ? "running"
                : "idle";

        workers.set(node.id, {
          nodeId: node.id,
          status,
          retryCount: node.retries ?? 0,
          maxRetries: node.maxRetries ?? 3,
          startedAt: node.startedAt,
          completedAt: node.completedAt,
          durationMs: node.durationMs,
          assignment: loaded.capabilityAssignments?.[node.id],
        });

        if (node.status === "done") {
          completedNodes.add(node.id);
        }
      }

      this.state = {
        ...this.state,
        workers,
        completedNodes,
      };

      return true;
    }
    return false;
  }

  /**
   * 이벤트 추가
   */
  private addEvent(event: OrchestrationEvent): void {
    this.state = { ...this.state, events: [...this.state.events, event] };
  }

  /**
   * 상태 조회
   */
  getStatus(): OrchestrationState["status"] {
    return this.state.status;
  }

  getStartedAt(): string {
    return this.state.startedAt;
  }

  getCompletedAt(): string | undefined {
    return this.state.completedAt;
  }

  getError(): string | undefined {
    if (this.orchestrationError) {
      return this.orchestrationError;
    }
    for (const worker of this.state.workers.values()) {
      if (worker.status === "failed" && worker.error) {
        return worker.error;
      }
    }
    return undefined;
  }

  /**
   * 초기화
   */
  initialize(): void {
    this.state = { ...this.state, status: "running" };
  }

  /**
   * 상태 설정
   */
  setStatus(status: OrchestrationState["status"]): void {
    this.state = { ...this.state, status };
  }

  setCompletedAt(completedAt: string): void {
    this.state = { ...this.state, completedAt };
  }

  setError(error: string): void {
    this.orchestrationError = error;
  }

  /**
   * 이벤트 발생
   */
  emitEvent(event: OrchestrationEvent): void {
    this.addEvent(event);
  }

  /**
   * 상태 요약 출력
   */
  formatSummary(): string {
    const workers = this.getAllWorkers();
    const running = workers.filter((w) => w.status === "running");
    const completed = workers.filter((w) => w.status === "completed");
    const failed = workers.filter((w) => w.status === "failed");
    const idle = workers.filter((w) => w.status === "idle");

    const lines: string[] = [];
    lines.push("📊 Orchestration Status");
    lines.push("─".repeat(50));
    lines.push(`Run ID: ${this.state.runId}`);
    lines.push(`Status: ${this.state.status}`);
    lines.push(`Started: ${this.state.startedAt}`);
    if (this.state.completedAt) {
      lines.push(`Completed: ${this.state.completedAt}`);
    }
    lines.push("");
    lines.push(`Workers: ${workers.length} total`);
    lines.push(`  🟢 Completed: ${completed.length}`);
    lines.push(`  🔵 Running: ${running.length}`);
    lines.push(`  ⚪ Idle: ${idle.length}`);
    lines.push(`  🔴 Failed: ${failed.length}`);
    lines.push("");

    if (running.length > 0) {
      lines.push("Running Workers:");
      for (const worker of running) {
        lines.push(`  • ${worker.nodeId} (retry: ${worker.retryCount}/${worker.maxRetries})`);
      }
      lines.push("");
    }

    if (failed.length > 0) {
      lines.push("Failed Workers:");
      for (const worker of failed) {
        lines.push(`  • ${worker.nodeId}: ${worker.error ?? "Unknown error"}`);
      }
    }

    return lines.join("\n");
  }
}
