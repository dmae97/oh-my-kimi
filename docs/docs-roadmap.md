# OMK 문서 로드맵 (v0.91.x → v0.92.0)

> 작성: 2026-07-22 · 근거: 하네스 감사(79/100)에서 문서 항목 7/10의 감점 원인
> 원칙: 문서-코드 발散 제거, 단일 소스 원칙(SSOT), 릴리즈마다 자동 검증

---

## 현재 문제 (감사 결과)

| # | 문제 | 위치 |
|---|------|------|
| P1 | 옛 리포 링크 (`earendil-works/omk-mono`) | `packages/coding-agent/docs/development.md` L3, L8 |
| P2 | adaptorch-wpl 상태 모순: 루트는 "experimental, not yet wired", 패키지는 "Stable, runtime dep" | `README.md` (루트) vs `packages/adaptorch-wpl/README.md` |
| P3 | 릴리즈 섹션 중복: 루트 README는 v0.90.9까지, coding-agent README는 v0.91.0까지 — 두 파일이 수동으로 따로 갱신됨 | `README.md` vs `packages/coding-agent/README.md` |
| P4 | generated 파일(`models.generated.ts`) 드리프트로 커밋↔CI 문서/코드 불일치 재발 | `packages/ai/src/models.generated.ts` |
| P5 | knowledge graph stale (7일, 100+ 커밋 뒤처짐) | understand-anything 그래프 |
| P6 | skills/MCP 문서는 "최소 코어"를 말하지만 실제 배포 기본값은 800+ skills, 20 MCP — 문서와 런타임 괴리 | `docs/skills.md`, 런타임 기본값 |

---

## Phase 1 — 즉시 수정 (이번 주, v0.91.1)

목표: P1–P3 사실 오류 제거. 커밋 1~2개로 끝남.

- [x] **T1** `development.md` 리포 링크 수정 → `dmae97/omk` — 9개 docs 파일 50+ 링크 일괄 교체 (gondolin 별개 프로젝트는 유지)
- [x] **T2** 루트 README의 adaptorch-wpl 섹션을 패키지 README 상태와 동기화 ("Stable, CLI runtime dependency since v0.91.0")
- [x] **T3** 루트 README에 v0.91.0 릴리즈 섹션 추가 — marker 블록 기반 자동 생성으로 전환 (Phase 2와 통합)
- [x] **수용 기준**: `rg -n 'earendil-works' README.md packages/coding-agent/docs` 결과 gondolin 외 0건, `npm run check` 통과

## Phase 2 — SSOT 구조 (v0.91.x, 1~2주)

목표: 릴리즈 노트 단일 출처화. 수동 이중 갱신 제거.

- [x] **T4** 릴리즈 섹션 생성 스크립트: `scripts/sync-readme-releases.mjs` — CHANGELOG 최신 3개 → 루트 README marker 블록 재생성, 상대 링크를 루트 기준으로 재작성
- [x] **T5** `check:readme-releases`를 `npm run check` 체인에 추가 + `release.mjs` 아티팩트 재생성 단계에서 자동 동기화
- [x] **T6** (포함) T4 생성 방식 전환으로 hard-pin 본문 링크는 생성물이 됨 — CHANGELOG 내 깨진 상대 링크(`../../agent/README.md`)도 함께 수정
- [x] **수용 기준**: CHANGELOG만 수정하면 루트 README가 자동 동기화, drift 시 `check:readme-releases` 실패

## Phase 3 — 런타임-문서 정합 (v0.92.0)

목표: 문서가 말하는 기본값 = 실제 기본값.

- [x] **T7** 기본 로드아웃 실측: 배포 패키지에 번들 스킬/MCP 0개 — 685 skills/20 MCP는 사용자 로컬 설정이며 제품 기본값이 아님 (감사 지적 P6은 오류로 판명)
- [x] **T8** `skills.md`에 "no built-in skills, 기본 세션은 스킬/MCP 0개" 명시. "No MCP" 철학과 모순 없음 확인
- [x] **T9** `packages/ai` build에서 `models.generated.ts` 재생성 제거 — 커밋된 파일을 그대로 사용, 재생성은 `generate-models` 스크립트와 `release.mjs`에서만 수행. 빌드 후 drift 0건 확인
- [x] **수용 기준**: 배포 tarball에 스킬 0개 확인 (`npm pack --dry-run`), 문서 명시 완료

## Phase 4 — 문서 품질 게이트 (지속)

- [x] **T10** CI에 링크 검사 추가: `scripts/check-doc-links.mjs` — 상대 링크 존재 확인 + legacy 리포 참조 차단 (gondolin 제외), 코드펜스 난 무시, check 체인 연결. 기존 깨진 링크 4건(tui.md plan-mode, CHANGELOG agent README, 루트 AGENTS.md, adaptorch-preview gitignored 아티팩트)도 함께 수정
- [x] **T10b** release-surface 게이트: `scripts/check-release-surface.mjs` — 5개 배포 패키지 tarball에 `.omk` 상태/루트 이스케이프/중첩 node_modules 금지, check 체인 연결
- [x] **T11** understand-anything 그래프 리빌드 완료 (1434 nodes). CI 주간 리빌드는 별도 과제로 이연
- [x] **T12** `CONTRIBUTING.md`에 docs 체크리스트 추가. 부수 발견: 삭제됐던 루트 `AGENTS.md`(CLAUDE.md import/CONTRIBUTING 참조의 SSOT) 복원

---

## 우선순위 요약

1. **T1+T2+T3** — 사실 오류, 30분짜리. 오늘 커밋 가능
2. **T4+T5** — 재발 방지 구조. 다음 릴리즈 전 필수
3. **T9** — 이번 CI 빨간불의 실제 원인 중 하나. Phase 2와 병행 가능
4. 나머지 — v0.92.0 목표

## 안 하는 것 (YAGNI)

- 문서 번역 체계 — 요청 없음
- 별도 docs 사이트 빌드 도구 교체 — omk.dev가 이미 docs.json으로 서빙 중
- JSDoc/TSDoc 전면 도입 — 31만 라인에 사후 적용 비용 대비 효과 낮음

---

## 검증 로그

- **2026-07-22 재검증**: Phase 1–4 수용 기준 실측 재확인. 3개 문서 게이트 그린(`check:readme-releases`·`check:doc-links`·`check:release-surface` 모두 EXIT 0). T1(gondolin 외 earendil-works 0건)·T11(그래프 1449 nodes, 1시간 전 분석)·T12(루트 AGENTS.md 존재) 재확인.
  - **잔여 T2 드리프트 수정**: `packages/adaptorch-wpl/README.md` L3가 "Stable (v0.90.9) … workspace dependency"로 정체 — 코드(`package.json` 0.91.0, coding-agent `^0.91.0` 런타임 의존)·루트 README와 모순. → "Stable (v0.91.0) … runtime dependency"로 동기화(SSOT 복원).
  - **유일 이연 항목**: T11의 "CI 주간 그래프 리빌드"는 별도 과제로 유지(그래프 자체는 최신).
