# AdaptTorch Preview Algorithm

## English — AdaptTorch Preview Algorithm

**AdaptTorch Preview** is a **read-first planning pipeline** for OMK sessions that need AdaptOrch-aware routing without prematurely submitting control-plane runs. It composes domain loadout signals, optional local topology classification (`adaptorch_capabilities`, `adaptorch_route_topology`), lane grants with explicit write scopes, dispatch cardinality hypotheses, and adjudicator evidence contracts—then hands a `PreviewResult` to the root coordinator for DAG execution or deterministic fallback.

Use preview when:

- Decomposing a goal into parallel lanes with non-overlapping writers.
- Deciding whether AdaptOrch adds value beyond local OMK routing (explorer → planner → coder → tester → reviewer).
- Documenting what evidence must exist before claiming verification or synthesis.

Do **not** treat preview output as proof that `adaptorch_run` completed; terminal run status, artifacts, and tests remain the evidence classes for execution claims.

Related packages:

- WPL loop package: `packages/adaptorch-wpl/` (stable since 0.91.0; ships with the CLI as a runtime dependency).
- Advisory bridge (default-off): `packages/coding-agent/src/core/adaptorch-bridge.ts`.
- Grok + AdaptOrch presets: [grok-harness.md](./grok-harness.md).

---

## 한국어 — AdaptTorch 프리뷰 알고리즘

**AdaptTorch Preview**는 AdaptOrch 제어 평면에 `adaptorch_run`을 **아직 제출하지 않은 상태**에서, OMK가 도메인 신호·토폴로지 분류·레인 그랜트·디스패치 규모 가설·검증 증거 계약을 한 번에 정리하는 **읽기 우선 계획 파이프라인**입니다. 결과 `PreviewResult`는 루트 코디네이터가 DAG 병렬 실행 또는 로컬 폴백을 선택할 때 사용합니다.

프리뷰를 쓰는 경우:

- 동일 파일을 두 레인이 쓰지 않도록 쓰기 범위를 나눈 병렬 작업을 설계할 때.
- AdaptOrch가 로컬 OMK 라우팅보다 실질적 이득이 있는지(탐색 → 계획 → 구현 → 테스트 → 리뷰) 판단할 때.
- "완료"·"검증됨"을 주장하기 전에 어떤 증거 파일·명령 출력이 필요한지 문서화할 때.

프리뷰 결과만으로 `adaptorch_run`이 성공했다고 **주장하면 안 됩니다**. 실행 주장에는 터미널 run 상태, 아티팩트, 테스트/체크 출력이 필요합니다.

관련 경로:

- 실험 WPL 루프: `packages/adaptorch-wpl/` (설계 단계, 기본 CLI 미연결).
- 어드바이저리 브리지(기본 비활성): `packages/coding-agent/src/core/adaptorch-bridge.ts`.
- Grok 세션: [grok-harness.md](./grok-harness.md).

---

## Claim boundary (allowed vs forbidden phrasing)

| Forbidden (do not say without execution evidence) | Allowed (preview / planning) |
| --- | --- |
| "AdaptOrch finished the task" / "run succeeded" | "Topology preview classified as DAG" |
| "Verified in production" / "deployed via AdaptOrch" | "Lane grants composed; evidence path is …" |
| "AdaptOrch proved correctness" | "Skipped AdaptOrch: no verified transport" |
| "Automatically executed the loop" | "Preview recommends `adaptorch_route_topology` then local synthesis" |
| Implying OAuth/token health without bounded check output | "Use read/local tools only until transport is granted" |
| "OMK guarantees" outcomes | "Models execute. OMK routes, verifies, measures, and controls." |

When in doubt, cite an evidence class from `AGENTS.md` (read, diff, test output, `npm run check`) or point to `.omk/goals/<id>/evidence/`.

---

## Full structured spec (LaTeX-aligned)

The canonical stage breakdown (Inputs, Stages A–F, Algorithms 1–3 as pseudocode) lives in the goal artifact:

**[adaptorch-preview-spec.md](./adaptorch-preview-spec.md)**

Use that file for implementation planning; this page is the operator-facing intro and claim boundary.

---

## OMK positioning

Models execute; **OMK routes, verifies, measures, and controls**. AdaptTorch Preview sits in the **route + verify** layer: it turns ambiguous goals into explicit lane grants and evidence contracts before any model spends write tokens on shared paths. AdaptOrch MCP tools may inform topology, but lane authority, hooks, and success predicates remain OMK-owned unless the user explicitly delegates a mutating control-plane lane.

---

## Grok sessions

For provider presets, Imagine tool discipline, and when to load AdaptOrch skills on Grok chat models, see **[grok-harness.md](./grok-harness.md)** (canonical playbook: `~/.omk/agent/grok.md`).

## Correctness Wall (preview)

For **patch apply safety** (scope, secret-shaped diff lines, optional outcome adjudication), use the B2C **Correctness Wall** harness — not to be confused with this planning preview.

- Canonical doc: **[correctness-wall.md](./correctness-wall.md)**
- User verdicts: **PASS**, **ADVISORY**, **INCONCLUSIVE**, **BLOCKED** with next actions **Apply**, **Deep Check**, **Regenerate**
- **This wall is not proof of correctness**; it is a conservative, evidence-limited screen before applying AI-generated edits.
