# Project Direction — 2026-05-18

## Summary

open-multi-agent-kit(OMK)의 현재 방향성은 **Kimi-native verified agent runtime**이다. Kimi가 작성·병합·최종 판단 권한을 유지하고, OMK는 그 주변의 실행 제어면을 담당한다: DAG 실행, evidence gate, 로컬 그래프 메모리, MCP/skills/hooks 라우팅, provider fallback, run replay/inspect, HUD/cockpit 가시성, worktree 격리.

핵심 문장:

> Kimi writes. OMK coordinates, verifies, remembers, and guards.

이 방향은 `README.md`, `ROADMAP.md`, `MATURITY.md`, init templates, `src/orchestration/*`, `src/goal/*`, `src/mcp/*`가 공통으로 지향하는 제품 축이다. 2026-05-18 안정화 이후 source/fresh-init 기준은 **project-local `omk-core-verified` baseline**으로 정렬되었고, 기존 생성 `.omk/*` artifact drift는 별도 운영 caveat로 취급한다.

2026-05-24 이후 native root/runtime 알고리즘의 현재 후속 기준은
[`native-root-runtime-hardening.md`](./native-root-runtime-hardening.md)와
[`native-root-runtime-algorithms.md`](./native-root-runtime-algorithms.md)이다.
이 문서는 방향성 기록으로 유지하며, ActionAtom/Novelty Guard 표현은
구현 및 테스트가 확인된 범위와 구분한다.

## Stabilization update — Kimi CLI / `.kimi`

- Fresh init: project-local `.kimi/mcp.json`, project scopes, `omk-core-verified`.
- Trusted local mode: `--local-user` 또는 `OMK_*_SCOPE=all`에서만 user/global `~/.kimi/mcp.json`, skills, hooks를 runtime에 결합한다.
- Isolated Kimi HOME: Kimi auth는 보존하되, project hook command는 absolute path로 rewrite하여 temp HOME 상대경로 문제를 막는다.
- DAG print runner: `KIMI_BIN`을 존중하고 `.kimi`/MCP runtime cache를 source project 기준으로 정규화한다.
- `kimi-wire`: print runtime과 isolated HOME/MCP/hook parity가 완성될 때까지 opt-in(`OMK_ENABLE_KIMI_WIRE=1`)이다.
- Runtime evidence: state/evidence/attempt/event/checkpoint artifacts는 secret-looking 문자열을 저장 전 redaction한다.

## Current product thesis

OMK는 단순 prompt pack, 범용 multi-model router, 또는 모델에게 모든 write/merge 권한을 넘기는 agent buffet가 아니다.

OMK가 되어야 하는 것은 다음이다.

- Kimi Code를 중심에 둔 local-first coding control plane
- 작업을 goal / action atom / DAG / evidence / graph로 명시화하는 실행 런타임
- 사람이 현재 실행 상태, 변경 파일, evidence, blocker, retry/fallback 이유를 볼 수 있는 운영 UI
- remote provider와 MCP를 기본 신뢰가 아니라 **명시적 권한·증거·fallback 계약**으로 다루는 안전한 agent harness

## Product pillars

### 1. Stable verified Kimi core

일상 사용 경로는 보수적으로 안정화해야 한다.

```txt
omk init → omk doctor → omk chat / omk plan → omk verify → omk summary / inspect
```

`MATURITY.md` 기준 stable surface는 `init`, `doctor`, `chat`, `hud`, `cockpit`, `plan`, `mode`, `runs/history`, `index`, `lsp`, `design`, `google`, `update`, `star`다. 이 경로는 public user가 매일 써도 되는 “boring reliable core”로 유지되어야 한다.

### 2. IntentFrame / ActionAtom / DAG execution spine

현재 런타임은 단일 prompt 실행에서 명시적 action graph로 이동 중이다.

```txt
User intent
  → GoalSpec / IntentFrame
  → ActionAtoms
  → DAG nodes with routing, retries, timeout, evidence gates
  → Executor / Scheduler
  → Decision trace + run state
  → Verify / Summary / Graph memory
```

관련 영역:

- `src/goal/intent-frame.ts`
- `src/goal/compiler.ts`
- `src/orchestration/dag.ts`
- `src/orchestration/executor.ts`
- `src/orchestration/evidence-gate.ts`
- `src/evidence/decision-trace.ts`

v1.2 방향은 이 spine을 “있는 기능”이 아니라 “모든 자동화가 따르는 계약”으로 고정하는 것이다.

### 3. Evidence-gated completion

OMK의 차별점은 “done by narration”을 거부하는 것이다. 완료 판단은 다음 증거에 묶여야 한다.

- 파일 존재 / diff 존재
- command-pass 결과
- review-pass 결과
- run summary / report
- provider fallback metadata
- decision trace
- replay/inspect artifact
- graph edge: `Goal → Run → DagNode → EvidenceGate → Artifact`

`omk verify --json`은 최소 완료 증거로 유지하고, 자동화가 소비하는 command는 stable JSON envelope를 제공해야 한다.

### 4. Local-first graph memory and forensic audit

그래프 메모리는 단순 요약 저장소가 아니라 audit substrate가 되어야 한다.

- `.omk/memory/graph-state.json`을 project-local source of truth로 유지한다.
- `.omk/memory/*.md`는 사람이 읽는 mirror/cache로 취급한다.
- optional Kuzu backend는 고급 쿼리용으로 유지한다.
- 기본 모드는 daemon/password 없는 local graph다.

다음 단계는 `Run`, `Goal`, `DagNode`, `EvidenceGate`, `ProviderAttempt`, `FallbackEvent`, `Artifact`, `Decision`, `Risk` 노드를 명시하고 `verify`, `goal`, `parallel`, provider runtime이 일관된 edge를 기록하게 하는 것이다.

### 5. Runtime presets as product modes

프리셋은 설정 묶음이 아니라 제품 trust mode다.

| Preset | Direction | Trust posture |
|---|---|---|
| `omk-core-verified` | everyday coding/refactor/debug baseline | conservative default |
| `omk-parallel-orchestrator` | max parallel agent orchestration | high-trust, opt-in recommended |
| `omk-ts-product` | strict TS/React/Next/Nest/API/UI work | product implementation lane |
| `omk-worktree-team` | isolated parallel worktree lanes | merge/review gated |
| `omk-release-guard` | release/security evidence gate | narrowed authority |
| `omk-full-mcp` | all configured MCP integration | explicit high-trust mode |

Source templates now generate `omk-core-verified` as the fresh-init active/default preset. 기존 repository-local `.omk/runtime*.json` 파일은 ignored/generated artifact일 수 있으므로, release/demo 전에는 `omk doctor`와 runtime secret scan으로 drift를 확인한다.

권장 결정:

1. public default는 `omk-core-verified`로 유지한다.
2. `omk-parallel-orchestrator`는 “all agents / all MCP / full hooks”가 필요한 명시적 고신뢰 모드로 표시한다.
3. full MCP와 secret-backed MCP는 release/security preset에서 자동 사용하지 않는다.

### 6. Advisory provider lanes only

DeepSeek 등 외부 provider는 당분간 write authority를 갖지 않는다.

허용 방향:

- explorer / reviewer / QA / planner / docs / research lane
- low-risk, read-heavy, advisory output
- Kimi fallback mandatory
- provider attempt / fallback reason / final authority marker 기록

금지 방향:

- provider가 직접 merge/write authority 보유
- provider fallback 실패가 evidence 없이 성공 처리
- provider output이 graph/summary에 출처 없이 섞이는 것

### 7. Operator visibility as core UX

HUD/cockpit은 부가 기능이 아니라 OMK의 운영 면이다.

보여야 하는 것:

- active run / session / goal
- worker state, role, ETA
- changed files
- TODOs
- blockers
- evidence gate status
- provider route/fallback counts
- MCP/skills/hooks inventory summary
- run replay/inspect links

`team`/tmux 모드는 이 가시성이 충분해질 때까지 experimental로 유지해야 한다.

### 8. Resource-aware local execution

OMK는 16GB/WSL/laptop에서도 안전하게 돌아가야 한다.

- lite/standard/super profile 유지
- bounded shell/wire output buffers
- worker count는 resource profile과 명시 override가 모두 반영되도록 정리
- all-scope MCP/skills/hooks는 high-trust opt-in으로 취급
- default project execution은 가능한 한 project-local로 유지
- bounded output buffers, request timeouts, abort signals는 성능 옵션이 아니라 reliability contract다.

## Roadmap ordering

### P0 — contract, security, runtime consistency

1. MCP host permission/governance/redaction 유지
2. MCP request/startup timeout 유지
3. secret-backed MCP와 `mcp_scope = all`은 trusted local opt-in으로만 유지
4. runtime preset source default는 `omk-core-verified`로 유지
5. evidence/log/checkpoint/runtime artifact redaction 유지
6. Kimi CLI `.kimi` isolated HOME / relative path parity 유지
7. release tag/package version 일치 검증
8. tarball audit를 실제 tarball extract 기준으로 유지

### P1 — evidence and audit graph

1. stable `CommandEnvelope<T>` / `EvidenceEnvelope` 정의
2. graph/DAG/summary/workflow JSON 계약 확대
3. provider fallback metadata coverage 확대
4. `graph view`를 audit evidence surface로 승격
5. HUD/cockpit에 provider/evidence/worker health 추가

### P2 — execution depth

1. executor timeout/abort cancellation을 모든 신규 runner/child process까지 계속 전파
2. dynamic fallback node resume 재현성 확보
3. checkpoint restore protected-path policy 확장
4. `team` 실행 상태·pane·worktree·artifact·verification reporting 강화
5. capability routing rationale를 summary/inspect에 표시

### P3 — broader integrations

1. remote MCP version pinning / provenance 정책
2. external provider lane 확대는 read-only/advisory 품질 게이트 후 진행
3. design/open-design bridge는 DESIGN.md token과 accessibility gate 기반으로 유지

## Known limitations as of 2026-05-18

- 기존 생성 `.omk/runtime*.json` artifact는 source/fresh-init default와 다를 수 있다.
- 일부 user/global MCP runtime은 high-trust secret-backed shell wrapper와 unpinned `npx -y`/`@latest`에 의존할 수 있다.
- `kimi-wire`는 `.kimi` isolated HOME/MCP/hook parity 전까지 opt-in이다.
- `team`은 maturity상 experimental이며, run reconstruction이 충분하지 않다.
- `graph view`는 유용하지만 ontology/run/evidence/provider linking이 아직 완성된 audit substrate는 아니다.
- JSON contract는 `doctor`, `verify`, 일부 provider/screenshot/goal 경로에 있으나 graph/DAG/summary/workflow까지 완전히 균일하지 않다.
- full test suite는 느린 MCP/init 테스트와 dist freshness 정책 차이로 로컬/CI 결과 해석에 주의가 필요하다.
- historical docs는 trajectory 참고 자료이며, 현재 truth는 `README.md`, `ROADMAP.md`, `MATURITY.md`, `.omk/runtime*.json`, 실제 source/test 결과를 함께 봐야 한다.

## Operating rule for next changes

새 기능 추가보다 먼저 다음 invariant를 만족해야 한다.

```txt
safe default ≤ project-local scope ≤ evidence-gated completion ≤ reproducible run artifacts ≤ no secret leakage
```

이 invariant를 만족하지 않는 “all agents / all MCP / all hooks” 모드는 기본값이 아니라 명시적 고신뢰 모드로 다뤄야 한다.
