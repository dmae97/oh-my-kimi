# OMK DAG + Agent Ensemble Runtime — 2026-05-01

Current successor reference: the native runtime bridge extends this historical
DAG/ensemble direction with context-capsule conversion and intent-aware runtime
fallback in
[`native-root-runtime-algorithms.md`](./native-root-runtime-algorithms.md)
(Algorithms 3 and 5).

## OSS DAG 선택

GitHub 공개 지표 기준으로 `dagrejs/dagre`가 더 많은 stars를 갖지만, 해당 프로젝트는 directed graph **layout** 라이브러리다. OMK 런타임에는 layout보다 작업 의존성 검증, topological order, runnable node 탐지가 필요하므로 같은 DagreJS 조직의 `dagrejs/graphlib` 설계를 기준으로 내부 DAG 인덱스를 구현했다.

- `dagrejs/dagre`: directed graph layout 중심
- `dagrejs/graphlib`: directed/multi-graph data structure + graph algorithms 중심

외부 dependency는 추가하지 않았다. 16GB RAM 최적화 모드와 CLI 설치 크기를 유지하기 위해 graphlib-style adjacency index/topological scheduler만 OMK 내부에 구현했다.

## 구현 내용

### DAG

- `src/orchestration/task-graph.ts`
  - node id 중복 검출
  - missing dependency 검출
  - Kahn topological sort
  - cycle path error
  - predecessor/successor adjacency index
  - scheduler용 runnable node 조회
- `src/orchestration/scheduler.ts`
  - 기존 O(N²) dependency scan을 cached DAG graph 조회로 교체
- `src/orchestration/dag.ts`
  - DAG 생성 시 graph validation을 공통 경로로 통합

### Agent ensemble

- `src/orchestration/ensemble.ts`
  - role별 candidate perspective 생성
  - candidate별 `TaskRunner.run()` 호출
  - weighted quorum aggregation
  - confidence marker(`confidence: 0.8`) 기반 scoring
  - winner output + ensemble summary 반환
  - `OMK_ENSEMBLE_*` env로 candidate context 전달
- `src/orchestration/executor.ts`
  - DAG executor가 기본적으로 ensemble runner를 감싼다.
  - `createExecutor({ ensemble: false })`로 비활성화 가능

## 기본 설정

```toml
[ensemble]
enabled = true
max_candidates_per_node = 2
max_parallel = 1
quorum_ratio = 0.5
```

16GB 환경을 고려해 candidate는 2개까지 호출하되 병렬도는 1로 유지한다. 병렬도를 올리고 싶으면:

```bash
OMK_ENSEMBLE_MAX_PARALLEL=2 omk run feature-dev "..."
```

완전히 끄려면:

```bash
OMK_ENSEMBLE=off omk run feature-dev "..."
```

## 검증

- DAG topological order
- cycle rejection
- role-specific ensemble candidate 호출
- weighted quorum aggregation
