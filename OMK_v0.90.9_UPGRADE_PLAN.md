# OMK v0.90.9 업그레이드 계획 — Algorithm Hardening & Reliability

> **상태:** 2026-07-19 로컬 freeze. workspace 패키지 버전은 `0.90.9`이며 미공개 상태다. 이 문서는 npm 또는 GitHub 공개 릴리스를 뜻하지 않는다.
> **기준:** `v0.90.9` workspace 라인 (`open-multi-agent-kit`, `omk-agent-core` 포함)
> **상세 명세:** [`OMK_v0.90.9_ALGORITHM_HARDENING_DETAILED_PATCH.md`](./OMK_v0.90.9_ALGORITHM_HARDENING_DETAILED_PATCH.md)
> **작성일:** 2026-07-15
>
> **로컬 freeze 스냅샷 (2026-07-19):** closed tool turn, deterministic resource-claim DAG와 `waves-v1` rollback, execution-bound evidence, transactional compaction, typed termination/session doctor, provider-origin-aware doctor 구현 표면을 문서화했다. `0.90.9`은 로컬 검증 경계의 미공개 snapshot이며 public release certification이 아니다.
>
> **검증 경계:** 로컬에서 `npm run build`, `npm run check`, 전체 `bash ./test.sh`, source CLI `bash ./omk-test.sh --no-env --help`, 네 publishable package의 `npm pack`, 격리된 npm/Bun 설치, Linux x64 Bun binary/archive, 세 CLI의 `--version`, package API/subpath import를 검증했다. live-provider 테스트와 타 OS smoke는 환경 경계로 남는다. npm publish, GitHub release, push, tag, dist-tag, trusted-publisher mutation은 실행하지 않았으며 권위 있는 WORM release infrastructure가 준비될 때까지 차단된다. 로컬 artifact evidence는 `/tmp/omk-g001-package-report.json`에 기록했다.

## 목표

v0.90.9는 공개 릴리스가 아닌 로컬 freeze이며, 기능 확장보다 런타임 신뢰성 강화에 집중하는 lockstep workspace snapshot이다.

1. 모든 emitted tool call을 정확히 하나의 terminal result로 닫는다.
2. 충돌하지 않는 tool call은 deterministic resource-claim DAG로 병렬화하고, 충돌·미확인 side effect는 절대 겹치지 않게 한다.
3. evidence gate를 신선한 실행 영수증(receipt)에 결합한다.
4. abort, timeout, compaction, crash, resume, provider 오류를 진단·복구 가능한 상태로 남긴다.

**로컬 freeze 문장:** OMK v0.90.9 workspace snapshot closes every tool turn, schedules independent work through a deterministic resource DAG, binds evidence to fresh execution receipts, and makes session termination diagnosable and recoverable. 이는 공개 배포 주장이 아니다.

## 현재 기준과 문서 원칙

- v0.90.8은 contiguous, source-ordered `partitionToolBatchWaves()`를 제공했다. v0.90.9 workspace snapshot은 deterministic resource-claim DAG를 추가하고 `waves-v1` rollback 경로를 유지한다.
- provider doctor는 native, custom OpenAI-compatible, local-proxy origin을 구분하는 sanitized 진단 표면을 제공한다.
- 현재 `packages/coding-agent/CHANGELOG.md`의 `[Unreleased]`에는 다른 작업의 secret-redaction 변경이 있다. 이 로컬 freeze는 그 WIP를 수정·출시 기능으로 표기하지 않는다.
- v0.90.9 문서는 구현 표면과 로컬 검증 경계만 기록하며 npm/GitHub publication을 주장하지 않는다.

## 범위와 우선순위

| ID | 우선순위 | 작업 | 릴리스 기준 |
| --- | --- | --- | --- |
| ALG-001 | P0 | Tool Transcript Closure Protocol | 필수 |
| ALG-002 | P0 | Resource-Claim DAG Scheduler v2 | 필수 |
| ALG-003 | P0 | Execution-Bound Evidence Receipt v3 | 필수 |
| ALG-004 | P1 | Timeout, cancellation, late settlement | 필수 |
| ALG-005 | P1 | Transactional context compaction | 필수 |
| REL-001 | P1 | Typed session termination and recovery | 필수 |
| PRV-001 | P1 | Custom-provider-aware doctor | 필수 |
| OBS-001 / PERF-001 | P2 | Metrics, diagnostics, performance regression criteria | 권장 |

### 비목표

- OS sandbox, filesystem/process/network 권한 시스템, arbitrary JavaScript tool의 강제 종료는 제공하지 않는다.
- scheduler와 evidence gate를 보안 경계로 주장하지 않는다. 강한 격리는 container, micro-VM, 또는 sandbox가 담당한다.
- provider 기능 동등성, 모델 품질 우위, issue #13의 root cause 확정은 이 patch의 완료 조건이 아니다.

## 구현 순서와 PR 경계

| 순서 | PR | 소유 범위 | 핵심 산출물 | 완료 조건 |
| --- | --- | --- | --- | --- |
| 0 | Baseline | 문서·tests | fault-injection fixtures, existing behavior snapshot | 기존 v0.90.8 동작과 uncommitted WIP를 분리한 기준 증거 |
| 1 | `feat(agent): close all tool calls on abort and resume` | `packages/agent` | transcript inspector, missing-only repair, synthetic terminal result, full-turn continuation guard | emitted call마다 terminal result 1개; duplicate/orphan은 fail closed; repair는 idempotent |
| 2 | `fix(agent): add per-tool timeout and late-settlement accounting` | `packages/agent` | child abort controller, timeout disposition, late-settlement audit | hanging call도 result 1개; timeout 뒤 결과는 transcript를 다시 변경하지 않음 |
| 3 | `feat(agent): replace contiguous waves with resource-claim DAG scheduling` | `packages/agent` | claims, conflict graph, stable levels, Node path identity resolver, `waves-v1` fallback | conflict overlap 0; independent later call의 head-of-line blocking 제거; source-order result 유지 |
| 4 | `feat(evidence): bind merge gates to fresh execution receipts` | `packages/coding-agent` guardrails | receipt v3, workspace/artifact fingerprint, atomic receipt store | strict mode가 metadata-only, non-zero exit, stale artifact, tampered ledger를 차단 |
| 5 | `fix(session): make compaction transactional and termination recoverable` | session/core/CLI | tool-turn barrier, hysteresis, revision CAS, run journal, typed termination, `session doctor` | open tool turn compact 금지; stale summary commit 금지; incomplete run dry-run repair 가능 |
| 6 | `fix(doctor): distinguish native and custom OpenAI-compatible providers` | doctor/config/CLI | provider origin, Level 0–2 probes, redacted diagnostics | root 404 + `/models` 200을 reachable로 분류; 401/403은 auth로 분류; credential 출력 0건 |
| 7 | Local freeze documentation | changelog, release note, README, upgrade plan | implemented-surface summary, migration/rollback boundary, local verification boundary | workspace `0.90.9` is documented as locally frozen and unpublished; no publish/push/tag/dist-tag/trusted-publisher action |

### 핵심 의존성

`ALG-001 → ALG-004 → ALG-002 → ALG-003 → ALG-005/REL-001 → PRV-001 → release`

Transcript closure와 terminal disposition을 먼저 고정한다. 그래야 DAG executor, receipt, compaction, repair가 같은 실행 상태를 해석한다.

## 설계·호환성 결정

### Agent scheduler

- built-in read-only tool은 공유 state를 변경하지 않는 범위에서 병렬화한다.
- path-scoped tool은 canonical path/resource claim으로 충돌을 계산한다.
- `bash`, unknown tool, external side-effect tool, explicit sequential policy는 exclusive가 기본이다.
- extension tool은 명시적 claim이 없으면 병렬 실행하지 않는다.
- 결과 artifact는 execution level과 관계없이 original source order로 반환한다.
- browser-safe lexical normalization은 유지하고, Node runtime에서는 `realpath`/identity resolver를 선택적으로 사용한다.

### Transcript, timeout, session

- blocked, aborted, skipped, timed-out, failed call 모두 동일한 terminal-result 계약을 사용한다.
- automatic repair는 **missing result만** 보완한다. duplicate/orphan result는 복구하지 않고 fail closed 한다.
- compaction은 closed tool-turn barrier 뒤에만 시작하며, snapshot revision compare-and-swap가 실패한 summary는 폐기한다.
- session format은 additive field만 추가한다. resume 전 integrity check와 run journal로 incomplete run을 드러낸다.

### Evidence

- receipt는 normalized command, exit code, workspace fingerprint, artifact digest, bounded/redacted output digest, replay-ledger binding을 포함한다.
- 기본 운영 모드는 `prefer`; release/security gate는 `strict`; legacy metadata는 읽을 수 있지만 strict gate를 열 수 없다.
- receipt 또는 repair event를 기록하기 전에 credential-shaped 값과 output excerpt를 redaction한다.

### Provider doctor

- provider origin을 native, custom OpenAI-compatible, local proxy로 구분한다.
- Level 0은 정적 config 검사, Level 1은 비파괴 network/capability probe, Level 2는 명시적 opt-in minimal model probe로 나눈다.
- root 404만으로 endpoint failure를 선언하지 않는다. `/models`, auth 상태, network reachability를 분리해 보고한다.

## 테스트 계획

각 PR은 관련 unit/regression test를 추가하고, 다음 fault matrix를 유지한다.

| Fault | 기대 결과 |
| --- | --- |
| tool throw / abort / hang | terminal result 정확히 1개 |
| timeout 뒤 late settlement | audit event 기록, transcript 재변경 없음 |
| missing result | unambiguous repair 가능 |
| duplicate 또는 orphan result | fail closed |
| artifact 변경 후 gate | `artifact-changed-after-verification` 차단 |
| ledger hash mismatch | fail closed |
| stale compaction result | discard |
| process crash | incomplete run 진단 및 repair preview |
| root 404, `/models` 200 | reachable/capability-aware 판정 |
| 401/403 | auth category |

로컬 freeze에서는 release command를 실행하거나 완료로 주장하지 않는다. 아래 명령과 Linux, macOS, Windows, 지원 Node 버전, 제공되는 경우 Bun install/smoke path 검증은 authoritative WORM release infrastructure가 준비된 뒤의 공개 릴리스 gate다.

```bash
npm run build
npm run check
./test.sh
./omk-test.sh
```

> **현재 검증 경계 (2026-07-19):** 로컬 build/check, keyless 전체 테스트, source CLI help, 네 package pack, isolated npm/Bun install, Linux x64 Bun binary/archive, CLI version, package API/subpath와 RPC smoke를 통과했다. live-provider와 macOS/Windows/다른 아키텍처는 검증하지 않았고 package/CLI/config/session/RPC/SDK의 새로운 공개 인증도 주장하지 않는다. 공개 릴리스 시 authoritative WORM release infrastructure에서 모든 gate를 다시 실행·확장해야 한다.

## 공개 릴리스 차단 기준

- 모든 emitted tool call에 terminal result가 정확히 하나이고, abort 뒤 provider 재호출이 없다.
- conflict tool은 겹치지 않고, deterministic DAG plan hash와 `waves-v1` rollback이 있다.
- strict evidence gate가 legacy metadata, stale artifact, non-zero exit, ledger tampering을 거부한다.
- open tool turn은 compact되지 않으며 stale compaction은 commit되지 않는다.
- typed termination, incomplete-run detection, `omk session doctor --repair --dry-run`이 동작한다.
- custom/native provider 분류와 404/401/403 fixture가 통과하며 credential 값이 출력되지 않는다.
- package version lockstep, changelog/release note/README 동기화, isolated npm pack/install smoke, rollback 절차가 검증되고 WORM 기반 release authority가 publish/push/tag/dist-tag/trusted-publisher mutation을 승인한다.

## 문서·릴리스 산출물

로컬 freeze에서 다음 문서를 갱신한다.

1. `packages/coding-agent/CHANGELOG.md` — 구현 표면, 로컬 검증 경계, 미공개 상태를 기록한다. `[Unreleased]`의 별도 WIP는 보존한다.
2. `.github/RELEASE_NOTES_v0.90.9.md` — release-note 형식의 로컬 freeze 요약과 publication 차단 상태를 기록한다.
3. `README.md` — DAG migration/`waves-v1` rollback, session/provider doctor의 안전한 시작점, 호환성 검증 경계를 기록한다.
4. 공개 release runbook과 publish verification은 WORM release infrastructure가 준비될 때까지 실행하지 않는다.

## 위험과 완화

| 위험 | 완화 |
| --- | --- |
| DAG가 모델의 숨은 의존성을 모름 | unknown/bash/external side effect는 exclusive; extension claim 필수 |
| realpath/identity 비용 | batch memoization과 lexical fallback |
| timeout 뒤 side effect | process executor kill, late-settlement audit, evidence invalidation |
| strict receipt가 기존 workflow를 막음 | 기본 `prefer`, release/security `strict`, migration report |
| repair가 손상을 숨김 | missing-only repair, audit record, duplicate/orphan fail closed |
| compaction CAS 재시도 | bounded retry와 stale result discard |
| endpoint probe의 비용·정보 노출 | non-generative default, model probe opt-in, redaction |
| patch 범위 과대 | additive APIs, 분할 PR, feature rollback, session format rewrite 금지 |

## 완료 정의

v0.90.9는 UI/기능 확장 release가 아니라 다음 세 불변식이 테스트와 release smoke로 입증되었을 때만 출시한다.

```text
Protocol integrity
+ Deterministic concurrency
+ Verifiable completion
```
