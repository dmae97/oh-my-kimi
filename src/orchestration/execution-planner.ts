/**
 * ExecutionPlanner — DAG 실행 계획 생성기
 *
 * 위상 정렬, 레벨 그룹핑, 워커 밸런싱, 임계 경로 분석을 수행하여
 * 병렬 에이전트 오케스트레이션을 위한 최적 실행 계획을 생성합니다.
 */

import type { DagNode } from "../orchestration/dag.js";
import type { ProviderPolicy, CapabilityManifest } from "../runtime/agent-runtime.js";

export interface NodeExecutionMeta {
  providerPolicy?: ProviderPolicy;
  capabilities?: CapabilityManifest;
}

export interface ExecutionPlan {
  batches: DagNode[][];
  nodeMeta: Map<string, NodeExecutionMeta>;
  totalWorkers: number;
  estimatedDuration: number;
  criticalPath: DagNode[];
  maxParallelism: number;
}

export interface ExecutionPlannerOptions {
  maxWorkers: number;
  dag: DagNode[];
}

/**
 * DAG 실행 계획 생성
 */
export function createExecutionPlan(options: ExecutionPlannerOptions): ExecutionPlan {
  const { dag, maxWorkers } = options;

  if (dag.length === 0) {
    return {
      batches: [],
      nodeMeta: new Map(),
      totalWorkers: 0,
      estimatedDuration: 0,
      criticalPath: [],
      maxParallelism: 0,
    };
  }

  // 1. 위상 정렬
  const sorted = topologicalSort(dag);

  // 2. 레벨별 그룹핑
  const levels = groupByLevel(sorted);

  // 3. 워커 수에 맞게 배치 조정
  const batches = balanceBatches(levels, maxWorkers);

  // 4. 임계 경로 계산
  const criticalPath = findCriticalPath(dag);

  // 5. 실제 배치 기준 최대 병렬성 계산
  const maxParallelism = Math.max(...batches.map((batch) => batch.length));

  const nodeMeta = new Map<string, NodeExecutionMeta>();
  for (const node of dag) {
    nodeMeta.set(node.id, {
      providerPolicy: deriveProviderPolicy(node.routing),
      capabilities: deriveCapabilityManifest(node.routing),
    });
  }

  return {
    batches,
    nodeMeta,
    totalWorkers: Math.min(maxWorkers, dag.length),
    estimatedDuration: calculateDuration(criticalPath),
    criticalPath,
    maxParallelism,
  };
}

/**
 * 위상 정렬 (Kahn's Algorithm)
 */
function topologicalSort(dag: DagNode[]): DagNode[] {
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();

  // 그래프 초기화
  for (const node of dag) {
    inDegree.set(node.id, 0);
    graph.set(node.id, []);
  }

  // 간선 및 진입 차수 계산
  for (const node of dag) {
    for (const dep of node.dependsOn) {
      const edges = graph.get(dep);
      if (edges) {
        edges.push(node.id);
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
      }
    }
  }

  // 큐에 진입 차수가 0인 노드 추가
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  const result: DagNode[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;

    visited.add(nodeId);
    const node = dag.find((n) => n.id === nodeId);
    if (!node) continue;

    result.push(node);

    // 인접 노드의 진입 차수 감소
    const neighbors = graph.get(nodeId) || [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // 순환 의존성 체크
  if (result.length !== dag.length) {
    const missing = dag.filter((n) => !visited.has(n.id));
    throw new Error(
      `Cyclic dependency detected. Missing nodes: ${missing.map((n) => n.id).join(", ")}`
    );
  }

  return result;
}

/**
 * 레벨별 그룹핑 (병렬 실행 가능한 노드들)
 */
function groupByLevel(sorted: DagNode[]): DagNode[][] {
  const levels: DagNode[][] = [];
  const nodeLevels = new Map<string, number>();

  for (const node of sorted) {
    // 의존 노드들의 최대 레벨 찾기
    const maxDepLevel = Math.max(
      -1,
      ...(node.dependsOn || []).map((dep) => nodeLevels.get(dep) ?? -1)
    );
    const level = maxDepLevel + 1;
    nodeLevels.set(node.id, level);

    if (!levels[level]) levels[level] = [];
    levels[level].push(node);
  }

  return levels;
}

/**
 * 워커 수에 맞게 배치 조정
 */
function balanceBatches(levels: DagNode[][], maxWorkers: number): DagNode[][] {
  const batches: DagNode[][] = [];

  for (const level of levels) {
    // 우선순위 기준으로 정렬
    const sorted = [...level].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    // 워커 수 초과 시 분할
    for (let i = 0; i < sorted.length; i += maxWorkers) {
      batches.push(sorted.slice(i, i + maxWorkers));
    }
  }

  return batches;
}

/**
 * 임계 경로 찾기 (동적 프로그래밍)
 */
function findCriticalPath(dag: DagNode[]): DagNode[] {
  const distances = new Map<string, number>();
  const predecessors = new Map<string, string | null>();

  // 초기화
  for (const node of dag) {
    distances.set(node.id, node.cost ?? 1);
    predecessors.set(node.id, null);
  }

  // 위상 정렬 순서로 최장 경로 계산
  const sorted = topologicalSort(dag);
  for (const node of sorted) {
    for (const dep of node.dependsOn) {
      const newDist = (distances.get(dep) || 0) + (node.cost ?? 1);
      if (newDist > (distances.get(node.id) || 0)) {
        distances.set(node.id, newDist);
        predecessors.set(node.id, dep);
      }
    }
  }

  // 최장 경로 끝 노드 찾기
  let endNode = sorted[0];
  let maxDist = 0;
  for (const node of sorted) {
    const dist = distances.get(node.id) || 0;
    if (dist > maxDist) {
      maxDist = dist;
      endNode = node;
    }
  }

  // 경로 역추적
  const path: DagNode[] = [];
  let current: string | null = endNode.id;
  while (current) {
    const node = dag.find((n) => n.id === current);
    if (node) path.unshift(node);
    current = predecessors.get(current) ?? null;
  }

  return path;
}

/**
 * 실행 시간 예측 (임계 경로 기반)
 */
function calculateDuration(criticalPath: DagNode[]): number {
  return criticalPath.reduce((sum, node) => sum + (node.cost ?? 1), 0);
}

function deriveProviderPolicy(routing?: DagNode["routing"]): ProviderPolicy | undefined {
  if (!routing) return undefined;
  return {
    strategy: "priority-first",
    preferredProviders: routing.provider && routing.provider !== "auto" ? [routing.provider] : [],
    fallbackChain: routing.fallbackProvider ? [routing.fallbackProvider] : [],
  };
}

function deriveCapabilityManifest(routing?: DagNode["routing"]): CapabilityManifest | undefined {
  if (!routing) return undefined;
  return {
    read: true,
    write: !routing.readOnly,
    shell: true,
    mcp: !!(routing.mcpServers?.length || routing.requiresMcp),
    patch: !routing.readOnly,
    review: !!(routing.skills?.some((s) => s.includes("review")) || routing.hooks?.some((h) => h.includes("review"))),
    merge: false,
    vision: !!(routing.skills?.some((s) => s.includes("vision")) || routing.assignedProviderCapabilities?.includes("vision")),
    streaming: true,
    structuredOutput: true,
    toolCalling: !!(routing.tools?.length || routing.requiresToolCalling),
  };
}

/**
 * 실행 계획 요약 출력
 */
export function formatExecutionPlan(plan: ExecutionPlan): string {
  const lines: string[] = [];

  lines.push("📋 Execution Plan Summary");
  lines.push("─".repeat(50));
  lines.push(`Total Batches: ${plan.batches.length}`);
  lines.push(`Total Workers: ${plan.totalWorkers}`);
  lines.push(`Max Parallelism: ${plan.maxParallelism}`);
  lines.push(`Estimated Duration: ${plan.estimatedDuration} units`);
  lines.push(`Critical Path: ${plan.criticalPath.map((n) => n.id).join(" → ")}`);
  lines.push("");

  lines.push("📦 Batches:");
  plan.batches.forEach((batch, index) => {
    lines.push(`  Batch ${index + 1} (${batch.length} workers):`);
    for (const node of batch) {
      lines.push(`    • ${node.id} [${node.role}] (priority: ${node.priority ?? 0})`);
    }
  });

  return lines.join("\n");
}

/**
 * 배치 실행 가능 여부 확인
 */
export function isBatchReady(batch: DagNode[], completed: Set<string>): boolean {
  return batch.every((node) => node.dependsOn.every((dep) => completed.has(dep)));
}

/**
 * 다음 실행 가능한 배치 찾기
 */
export function getNextExecutableBatch(
  plan: ExecutionPlan,
  completed: Set<string>
): DagNode[] | null {
  for (const batch of plan.batches) {
    if (isBatchReady(batch, completed)) {
      return batch;
    }
  }
  return null;
}
