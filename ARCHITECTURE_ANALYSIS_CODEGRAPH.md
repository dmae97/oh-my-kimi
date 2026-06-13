# OMK CLI 아키텍처 분석 보고서 (CodeGraph)

> 분석일: 2026-05-25
> 도구: CodeGraph (SQLite 기반 코드 의존성 그래프)
> 대상: /home/yu/open_multi-agent_kit (open-multi-agent-kit v1.1.18)

---

## 1. 개요

OMK CLI는 Commander.js 기반의 단일 진입점(entry point)을 가진 Node.js CLI 도구로, 4개의 핵심 축으로 구성됨.

## 2. Entry Point & Command Routing 흐름

Entry: src/cli.ts → main.ts → createOmkProgram() → registerCliCommands()
Root Flow (no args): runRootHudFlow() → HUD + mode selector + spawn

병목: Command Registry Coupling — register-*.ts가 commands/와 1:1 coupling

## 3. Theme System

src/brand/palette.ts (21색상) → src/util/theme.ts (God Module, 230 inbound)

## 4. Render Pipeline

src/hud/render.ts (42KB, 74 nodes, 115 outbound) → LiveHudRenderer

## 5. Orchestration

src/orchestration/executor.ts (39KB, DAG 실행 엔진)
src/orchestration/routing.ts (825L, 73 nodes)
src/orchestration/parallel-orchestrator.ts (650L, 59 nodes)

## 6. 의존성 분석 (CodeGraph 기반)

Hub Modules:
- src/util/fs.ts — 496 total degree
- src/util/theme.ts — 343 total degree
- src/providers/provider-router.ts — 298 total degree

최고 복잡도 파일:
- providers/provider-task-runner.ts — 1,442L
- mcp/omk-project-server.ts — 1,737L
- commands/mcp.ts — ~1,800L
- commands/design.ts — ~1,600L

순환 의존성: File-level 명확한 순환은 미발견. 단 theme.ts와 render.ts 간 강한 coupling 존재.

## 7. 병목 지점

Critical:
1. util/fs.ts (496 degree) → path/project/run으로 분리
2. util/theme.ts (343 degree) → ansi/colors/panels로 분리
3. providers/provider-task-runner.ts (1,442L) → runner/selection/state 분리

Major:
4. orchestration/routing.ts (825L)
5. mcp/omk-project-server.ts (1,737L)
6. hud/render.ts (1,300+L)

## 8. 개선 권장사항

P0: util/fs.ts, util/theme.ts, provider-task-runner.ts, routing.ts 구조적 분리
P1: commands/ 서브디렉토리화, cli/register 동적 임포트
P2: orchestration/ → execution/, routing/, ensemble/, evidence/ 분리
P3: theme.ts와 render.ts 간 interface 기반 의존성 전환

## 9. 결론

OMK CLI는 기능적으로 성숙했으나 구조적 부채가 누적된 상태.
핵심: util/fs.ts + util/theme.ts 허브화 → 1,000L+ 파일 5개 이상 → orchestration/ 책임 과다
권장 우선순위: fs/theme 분리 → provider-task-runner 분리 → orchestration 관심사 분리 → commands 서브디렉토리화

---

## 10. HUD Render Pipeline Decoupling (2026-05-25)

### 변경 개요
`src/hud/render.ts` → `src/util/theme.ts` 간 강한 coupling 해소 작업 완료.

### 생성/변경 파일
- `src/hud/types.ts` (새로 생성)
  - `HudStyle`, `HudStatus`, `SystemUsage`, `HudTheme` 인터페이스 정의
  - render pipeline이 필요로 하는 theme 계약을 당소화
- `src/util/theme.ts` (수정)
  - `hudTheme: HudTheme` 객체 추가 → 인터페이스 구현체
- `src/hud/render.ts` (성형 보전)
  - `theme.ts`의 직접 import를 제거하고 `HudTheme` 타입의 `theme` 객체를 하나의 출입점에서 사용
  - `fetchHudDashboardData()`: compact/medium/full/section 4개 모드의 중복되던 run state/git/session 폴링 로직 통합
  - `buildHudHeader()`: matrix rain + 헤더 + summary 생성 함수 분리
  - `buildHudFooter()`: 기존 `renderFooter` 을 이름 변경 후 독립 함수화
  - dashboard renderer 4개 모드 모두 `fetchHudDashboardData` + `buildHudHeader` + `buildHudFooter` 조합으로 단순화

### 결과
- **순환 의존성 해소**: render.ts → theme.ts 직접 의존이 `HudTheme` 인터페이스로 대체되면서 구현체 교체 시 단 하나의 import만 바뀌면 됨
- **코드 줄이기**: render.ts 1,300+줄 → 1,076줄 (약 18% 감소)
- **경로 최소화**: HUD 렌더러의 공통 데이터 폐치가 한 곳에서 관리되면서 바뀌는 경우의 추적성 향상
- **컴파일 성공**: `tsc --noEmit` 패스

---

## 11. OMK CLI V2 런타임 아키텍처 (2026-05-28)

> 아키텍처 문서: `OMK_CLI_V2_RUNTIME_ARCHITECTURE.md` (2058 lines)
> 구현 진행률: ~85%

### 11.1 핵심 문제 (해결됨)

1. **Prompt bloat**: 2자 요청에 전체 오케스트레이션 계약 전송 → `context-broker.ts`에서 `promptMode === "dnc-nlp"` 체크 추가
2. **available ≠ required MCP 분리**: `CapabilityPlan`로 분리 완료
3. **Optional MCP 실패 = 치명적**: 경고로 변경 완료
4. **Provider raw stdout 유출**: `ProviderEventNormalizer` → `OutputRouter` 경유 필수
5. **Slash commands 미연결**: `CommandBus`에 핸들러 등록 완료
6. **kimi-cli 의존성**: `kimi-api` (직접 Moonshot HTTP)로 대체 완료

### 11.2 런타임 파이프라인 (현재)

```
User Input → Clipanion CLI → OmkCommand.executePipeline()
  → CommandBus (slash commands registered)
  → IntentClassifier (classifyIntent)
  → CapabilitySelector (selectCapabilities)
  → RuntimeSidecar (compileBloatToNlp)
  → OutputRouter (ThemePalette resolve)
  → ThemeRenderer / NlpRenderer / JsonRenderer / NlgRenderer
```

### 11.3 핵심 런타임 파일

| 파일 | 라인 | 역할 |
|------|------|------|
| `src/runtime/contracts/command-envelope.ts` | ~130 | CommandKind, OutputFormat, StdoutMode, OutputProfile, OmkEvent, CapabilityPlan |
| `src/runtime/contracts/reasoning-trace.ts` | 144 | RTE 스키마 (ReasoningTrace, TraceSummary, ConsentAwareNlgInput/Output) |
| `src/runtime/debloat-nlp.ts` | ~531 | classifyIntent, classifyRisk, selectCapabilities, compileBloatToNlp, filterMcpConfigForTurn, selectProviderRuntime |
| `src/runtime/command-bus.ts` | 88 | CommandBus 인터페이스, slash → handler 매핑 |
| `src/runtime/slash-commands.ts` | 194 | SlashCommandParser + /model, /status, /theme, /help 핸들러 |
| `src/runtime/provider-event-normalizer.ts` | 555 | KimiEventNormalizer + KimiPrintNormalizer, i18n bilingual |
| `src/runtime/output-router.ts` | ~200 | OutputRouter 인터페이스, ThemePalette resolve, routeTrace, NLG renderer |
| `src/runtime/renderers.ts` | 272 | ThemeRenderer (opencode-style), NlpRenderer (bilingual), JsonRenderer |
| `src/runtime/ui-components.ts` | 301 | statusCard, providerCard, memoryCard, mcpHealthCard, errorBox, traceSummaryCard, consentNotice |
| `src/runtime/nlg-renderer.ts` | 190 | NlgRenderer (renderTrace, renderSummary, renderConsentReport, renderTurnResult) |
| `src/runtime/reasoning-trace.ts` | 354 | RTE 구현 (createReasoningTrace, redactTrace, summarizeTrace, generateConsentReport, createReasoningTraceStore) |
| `src/runtime/context-broker.ts` | 375 | ContextCapsule 빌더, promptMode dnc-nlp 체크 |
| `src/runtime/mimo-api-runtime.ts` | 35 | MiMo API 런타임 (KimiApiRuntime 확장) |
| `src/runtime/kimi-api-runtime.ts` | 445 | Moonshot API 직접 HTTP 런타임 |
| `src/runtime/runtime-router.ts` | 513 | 런타임 우선순위, provider → runtime 매핑 |

### 11.4 CLI v2 파일

| 파일 | 라인 | 역할 |
|------|------|------|
| `src/cli/v2/cli-v2-skeleton.ts` | ~340 | Clipanion 기반 7개 명령어 + 전체 파이프라인 |
| `src/cli/v2/chat-repl.ts` | ~170 | 대화형 REPL + 파이프라인 통합 |
| `src/cli/v2/interactive-prompt.ts` | 225 | Clack 프롬프트 |
| `src/cli/v2/persistent-memory.ts` | 350 | Section 17 영구 메모리 (.omk/memory/) |
| `src/cli/main.ts` | ~115 | OMK_CLI_V2=1일 때 모든 명령어 cli-v2로 라우팅 |

### 11.5 오케스트레이션 파일

| 파일 | 라인 | 역할 |
|------|------|------|
| `src/orchestration/interactive-orchestrator.ts` | 667 | InteractiveOrchestrator (goal-driven, SubAgentRole 10개) |
| `src/commands/parallel/interactive.ts` | 246 | omk parallel:interactive CLI 명령어 |

### 11.6 Provider 시스템

| 파일 | 역할 |
|------|------|
| `src/providers/model-registry.ts` | KnownProviderId (9개: codex/commandcode/deepseek/kimi/local-llm/mimo/opencode/openrouter/qwen), DEFAULT_PROVIDER_CONFIGS |
| `src/providers/provider-runtime.ts` | discoverKimiRuntime, discoverMimoRuntime (kimi-api/mimo-api 항상 등록) |
| `src/providers/types.ts` | ProviderId, ProviderPolicy, RuntimeId, DEFAULT_RUNTIME_FALLBACK_CHAIN |
| `src/runtime/runtime-bootstrap.ts` | resolveAutoProvider (mimo 자동 감지) |

### 11.7 i18n 시스템

- `src/util/i18n.ts` (~1070 lines): KO/EN 사전, `t()` 함수
- 키 카테고리: nlp.*, normalizer.*, ui.*, nlg.*
- `getLanguage()`, `setLanguage()`, `initI18n()`

### 11.8 테스트

- `test/v2-regression.test.mjs` (217 lines, 10/10 PASS)
- `test/cli-v2-gating.test.mjs` (2/2 PASS)

### 11.9 설정

- `~/.kimi/config.toml` (154 lines): default_model = "mimo/mimo-v2.5-pro", providers: mimo, kimi, deepseek, codex, opencode, openrouter, qwen
- `.omk/kimi.config.toml` (53 lines): hooks만 포함 (중복 키 해결)
- `~/.kimi/mcp.json`: 8개 MCP 서버 (context7, gh_grep, filesystem, playwright, memory, sequential-thinking, clearthought, obsidian)

### 11.10 아키텍처 문서 이행률

| 섹션 | 상태 | 비고 |
|------|------|------|
| 0-2 (Executive Summary, Problem, Target) | ✅ | 전체 파이프라인 구현 |
| 5-13 (Data Models ~ ProviderEventNormalizer) | ✅ | 타입 정렬 완료 |
| 14 (Theme Architecture) | ✅ | ThemePalette + UiComponents |
| 15 (NlpRenderer) | ✅ | bilingual i18n |
| 16 (Slash Command) | ✅ | CommandBus 핸들러 등록 |
| 17 (Persistent Memory) | ✅ | .omk/memory/ |
| 20 (Regression Tests) | ✅ | 6개 테스트 |
| 22 P1 (RuntimeSidecar, ThemeRenderer) | ✅ | |
| 22 P2 (Clipanion, Clack) | ✅ | cli-v2-skeleton + interactive-prompt |
| 4 (Directory Structure) | ❌ | flat 구조 유지 |
| 19 (Migration Plan Phase 4-5) | ❌ | |
| 21 (CLI v2 full migration) | ⚠️ | skeleton exists, wiring partial |

### 11.11 핵심 불변식 (I-001 ~ I-012)

- I-001: availableMcp ≠ prompt MUST activate
- I-004: optional failure = warning
- I-005: raw TurnBegin/StatusUpdate not in stdout
- I-006: status requiredMcp=[]
- I-008: slash command through CommandBus
- I-011: kimi-print debug-only

### 11.12 남은 작업

1. Section 21 CLI v2 전체 마이그레이션 (Commander → Clipanion)
2. Section 4 디렉토리 구조 재편
3. Section 19 Migration Phase 4-5
4. omk chat 실제 모델 연결 테스트
5. UI/UX opencode-style 최종 적용 확인
