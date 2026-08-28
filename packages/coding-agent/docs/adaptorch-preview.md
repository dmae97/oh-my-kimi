# AdaptOrch Preview Algorithm

## English — AdaptOrch Preview Algorithm

**AdaptOrch Preview** is a **documentation blueprint**, not a wired runtime. It describes a read-first planning pipeline that could combine domain signals, optional topology advice (`adaptorch_capabilities`, `adaptorch_route_topology`), scoped lane proposals, dispatch-cardinality hypotheses, and evidence contracts. No default OMK consumer executes a `PreviewResult`.

Use preview when:

- Decomposing a goal into parallel lanes with non-overlapping writers.
- Deciding whether AdaptOrch adds value beyond local OMK routing (explorer → planner → coder → tester → reviewer).
- Documenting what evidence must exist before claiming verification or synthesis.

Do **not** treat preview output as proof that `adaptorch_run` completed; terminal run status, artifacts, and tests remain the evidence classes for execution claims.

Related packages:

- WPL primitives: `packages/adaptorch-wpl/` (published runtime dependency; no default end-to-end CLI dispatch loop).
- Advisory bridge (default-off): `packages/coding-agent/src/core/adaptorch-bridge.ts`.
- Grok + AdaptOrch presets: [grok-harness.md](./grok-harness.md).

---

## 한국어 — AdaptOrch 프리뷰 알고리즘

**AdaptOrch Preview**는 배선된 런타임이 아니라 **문서 설계안**입니다. `adaptorch_run` 제출 전에 도메인 신호·토폴로지 자문·레인 제안·디스패치 규모 가설·검증 증거 계약을 정리하는 읽기 우선 파이프라인을 설명합니다. 기본 OMK 런타임은 `PreviewResult`를 실행하지 않습니다.

프리뷰를 쓰는 경우:

- 동일 파일을 두 레인이 쓰지 않도록 쓰기 범위를 나눈 병렬 작업을 설계할 때.
- AdaptOrch가 로컬 OMK 라우팅보다 실질적 이득이 있는지(탐색 → 계획 → 구현 → 테스트 → 리뷰) 판단할 때.
- "완료"·"검증됨"을 주장하기 전에 어떤 증거 파일·명령 출력이 필요한지 문서화할 때.

프리뷰 결과만으로 `adaptorch_run`이 성공했다고 **주장하면 안 됩니다**. 실행 주장에는 터미널 run 상태, 아티팩트, 테스트/체크 출력이 필요합니다.

관련 경로:

- WPL 프리미티브: `packages/adaptorch-wpl/` (공개 런타임 의존성, 기본 CLI end-to-end dispatch 배선 없음).
- 어드바이저리 브리지(기본 비활성): `packages/coding-agent/src/core/adaptorch-bridge.ts`.
- Grok 세션: [grok-harness.md](./grok-harness.md).

---

## Claim boundary (allowed vs forbidden phrasing)

| Forbidden (do not say without execution evidence) | Allowed (preview / planning) |
| --- | --- |
| "AdaptOrch finished the task" / "run succeeded" | "Topology preview returned `hybrid`; no run was submitted" |
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

Models execute; **OMK routes, verifies, measures, and controls**. AdaptOrch Preview is a route-and-evidence blueprint. AdaptOrch tools may advise topology, but preview output grants no lane authority and proves no execution; an actual caller must define ownership, hooks, and success predicates.

---

## Grok sessions

For provider presets, Imagine tool discipline, and when to load AdaptOrch skills on Grok chat models, see the canonical **[Grok harness guide](./grok-harness.md)**.

## Correctness Wall (preview)

For **patch apply safety** (scope, secret-shaped diff lines, optional outcome adjudication), use the B2C **Correctness Wall** harness — not to be confused with this planning preview.

- Canonical doc: **[correctness-wall.md](./correctness-wall.md)**
- User verdicts: **PASS**, **ADVISORY**, **INCONCLUSIVE**, **BLOCKED** with next actions **Apply**, **Deep Check**, **Regenerate**
- **This wall is not proof of correctness**; it is a conservative, evidence-limited screen before applying AI-generated edits.
