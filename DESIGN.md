# DESIGN.md — open_multi-agent_kit v1.2

## Product Identity

OMK is a provider-neutral verified agent runtime and root orchestrator, not a generic multi-model dashboard.

Core sentence:

> Kimi writes. OMK coordinates, verifies, remembers, and guards.

Design surfaces must show that Kimi is the primary coding authority while OMK exposes run state, evidence, graph memory, scoped MCP/skills/hooks state, worktree isolation, provider fallback, and operator controls. Never imply completion from narration alone; visual “done” states require command, diff, artifact, or review evidence.

Open Design bridge outputs must treat this `DESIGN.md` as the source of truth for tokens, product constraints, and brand direction. Catalog styles from Open Design or `awesome-design-md` are reference inputs only; adapt them to the local OMK system instead of replacing tokens or cloning external brands.

## Runtime Algorithm Reference

Runtime architecture visuals should summarize, not duplicate, the canonical
native root loop and routing algorithms in
[`docs/native-root-runtime-algorithms.md`](./docs/native-root-runtime-algorithms.md).
Show provider-neutral orchestration as a hardening milestone gated by evidence,
approval/sandbox policy, and adapter capability boundaries.

## Reference Design System

기준 디자인: **냥심판 (Nyang Judge)** — 따뜻한 크림 베이지 배경, 초콜릿 브라운 타이포그래피, 귀여운 고양이 판사 일러스트, 노랑 CTA, 오렌지 강조, 발바닥 별점이 있는 "살까 말까?" 구매 재판 앱의 디자인 시스템을 OMK에 통합.

에셋 출처: `/public/assets/` — `cat-judge.png`, `paw-rating.png`, `verdict-*.png`, `logo-600x600.png`
레퍼런스: `/public/assets/references/` — `dashboard.png`, `landing-and-form.png`, `my-page.png`, `records.png`, `result.png`

패키징 정책: `/public/assets/`는 웹사이트/디자인 작업용 **source-only reference asset**이며 현재 npm CLI 패키지에는 포함하지 않는다. 라이선스와 출처가 기록되지 않은 에셋은 source-only 상태로 유지하고, CLI/init 문서나 배포 패키지에 이미지가 필요하면 provenance(라이선스, 원출처, 사용 권한, 검토일)를 먼저 기록한 뒤 최소 선별본만 `readmeasset/` 또는 `docs/assets/`로 이동해 포함한다. `.gitignore`와 package audit은 `/public/assets/**`가 실수로 커밋되거나 npm tarball에 들어가는 것을 막는 방어선이다.

## Visual Direction

- **Mood**: 따뜻하고 아늑한 코리안 코트룸 토이박스 — "고양이 판사가 지켜보는 OMK 작업실"
- **Shape**: 20–30px 둥근 카드, pill 필터, 44px+ 터치 타겟
- **Layout**: max-width 430px 모바일 앱 셸, 데스크톱에서는 폰 프레임처럼 중앙 정렬 (HUD/cockpit은 풀와이드)
- **Illustration**: `cat-judge.png`를 OMK 마스코트로 사용; Kimicat은 보조 캐릭터
- **Animation**: fadeInUp, bounceIn, float, paw-pop, card-3d-tilt, scale-in-bounce

## Colors (냥심판 × OMK 통합)

### Page & Surface

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-page` | `#FFF8EF` | 메인 페이지 배경 |
| `--bg-page-soft` | `#FFFDF8` | 부드러운 배경 |
| `--bg-page-deep` | `#F8EAD7` | 깊은 배경 (그라데이션 하단) |
| `--bg-card` | `#FFFFFF` | 카드 배경 |
| `--bg-warm-card` | `#FFF4E6` | 따뜻한 카드 배경 |
| `--bg-soft` | `#FFFAF2` | 초부드러운 배경 |

### Brown Scale (텍스트/UI)

| Token | Hex | Usage |
|-------|-----|-------|
| `--brown-950` | `#2A170D` | 최고강조 텍스트 |
| `--brown-900` | `#3A1F10` | Primary 텍스트 |
| `--brown-800` | `#4A2A14` | 헤딩 |
| `--brown-700` | `#5A3219` | 강조 텍스트 |
| `--brown-600` | `#815029` | 서브헤딩 |
| `--brown-500` | `#9A6A42` | 중간 톤 |
| `--brown-300` | `#D8AA72` | 호버/액센트 |

### Yellow / CTA

| Token | Hex | Usage |
|-------|-----|-------|
| `--yellow-600` | `#F2A900` | CTA 호버 베이스 |
| `--yellow-500` | `#FFC83D` | Primary CTA |
| `--yellow-400` | `#FFD96B` | CTA 그라데이션 |
| `--yellow-300` | `#FFD978` | CTA 라이트 |

### Orange / Verdict Emphasis

| Token | Hex | Usage |
|-------|-----|-------|
| `--orange-600` | `#F05A28` | 강조 오렌지 |
| `--orange-500` | `#F47719` | 액센트 오렌지 |
| `--orange-400` | `#FF9358` | 라이트 오렌지 |

### Semantic Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--green-600` | `#2F9B4A` | 성공/통과 |
| `--green-100` | `#E9F8E8` | 성공 배경 |
| `--red-600` | `#E5482D` | 실패/위험 |
| `--red-100` | `#FFE1D8` | 위험 배경 |
| `--warning` | `#B35C00` | 경고 |
| `--warning-bg` | `#FFF0C7` | 경고 배경 |
| `--info` | `#536D7A` | 정보 |
| `--info-bg` | `#EAF5FF` | 정보 배경 |

### Border & Divider

| Token | Hex | Usage |
|-------|-----|-------|
| `--cream-border` | `#EED9C4` | 기본 보더 |
| `--cream-border-strong` | `#D8B58F` | 강조 보더 |

### Text Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#3A1F10` | 본문 텍스트 |
| `--text-secondary` | `#7D6148` | 보조 텍스트 |
| `--text-muted` | `#8B6F59` | 흐린 텍스트 |
| `--text-inverse` | `#FFF8EF` | 어두운 배경 위 텍스트 |

### Legacy Kimicat Colors (보존)

| Token | Hex | Usage |
|-------|-----|-------|
| `--kimicat-purple` | `#7B5BF5` | Kimicat 눈, 로고 액센트 |
| `--kimicat-pink` | `#EC4899` | 하트/장식 |
| `--kimicat-mint` | `#14B8A6` | 초코민트 테마 |
| `--kimicat-dark` | `#241C32` | 후디/다크모드 |

### Verdict Colors (에이전트 상태)

| 상태 | 색상 | Usage |
|------|------|-------|
| `PASS / DONE` | `#2F8A3B` on `#E7F6D9` | 성공/완료 |
| `FAIL / ERROR` | `#E85D1F` on `#FFE4D6` | 실패/에러 |
| `WARN / BLOCKED` | `#B35C00` on `#FFF0C7` | 경고/블록 |
| `INFO / PENDING` | `#536D7A` on `#E8EEF1` | 정보/대기 |

Operational status labels:

- `PASS`: verified by command, diff, review, or artifact.
- `WARN`: scope drift, provider fallback, skipped check, or partial evidence.
- `BLOCKED`: missing permission, failed gate, dirty worktree, unavailable MCP, or protected-path checkpoint.
- `ADVISORY`: provider/reviewer/research output without write authority.

## Operational Information Hierarchy

HUD/cockpit must prioritize:

1. active goal / run / session
2. current Kimi or worker lane
3. changed files and worktree location
4. TODO / blocker state
5. evidence gate status
6. scoped MCP / skills / hooks summary
7. provider route and fallback status
8. replay / inspect / graph links

## Typography

| Role | Font | Size | Weight |
|------|------|------|--------|
| Logo / Display | `'Cafe24 Ssurround'`, `'GmarketSans'`, `'Pretendard'` | 44–58px | 900 |
| Page Title | `'GmarketSans'`, `'Pretendard'` | 24px | 900 |
| Card Title | `'Pretendard'` | 17–20px | 900 |
| Body | `'Pretendard'`, `system-ui`, `-apple-system` | 13.5–15px | 600–800 |
| Labels / Captions | `'Pretendard'` | 11–14px | 800–900 |
| Code / CLI | `'JetBrains Mono'`, `'Fira Code'` | 13px | 400 |

Font Imports:
```css
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css');
/* Cafe24 Ssurround, GmarketSans via Google Fonts or CDN */
```

## Design Tokens (CSS Custom Properties)

```css
:root {
  /* Spacing scale */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;

  /* Border radius */
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --radius-xl: 28px;
  --radius-pill: 999px;

  /* Shadows */
  --shadow-card: 0 10px 26px rgba(91, 52, 24, 0.08);
  --shadow-soft: 0 16px 48px rgba(80, 45, 18, 0.12);
  --shadow-button: 0 5px 0 #D88A1D, 0 14px 24px rgba(216, 138, 29, 0.22);
  --shadow-nav: 0 -10px 34px rgba(61, 37, 23, 0.08);
  --shadow-hover: 0 18px 40px rgba(91, 52, 24, 0.14);
  --shadow-glow: 0 0 24px rgba(255, 189, 46, 0.35);

  /* Touch target */
  --touch-target: 44px;
}
```

## Component Patterns

### Cards (warm-card)

```css
.warm-card {
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid var(--cream-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-card);
  backdrop-filter: blur(8px);
  transition: transform 0.25s cubic-bezier(0.2, 0.85, 0.25, 1.1),
              box-shadow 0.25s ease;
}
.warm-card:hover {
  box-shadow: var(--shadow-hover);
  border-color: var(--cream-border-strong);
}
```

### Primary Button

```css
.primary-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 100%; min-height: 56px; gap: var(--space-2);
  border: 0; border-radius: 20px;
  background: linear-gradient(180deg, var(--yellow-400), var(--yellow-500));
  color: var(--brown-900);
  box-shadow: var(--shadow-button);
  font-weight: 800; font-size: 16px;
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.primary-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 7px 0 #D88A1D, 0 20px 32px rgba(216, 138, 29, 0.28);
}
.primary-button:active {
  transform: translateY(3px) scale(0.97);
  box-shadow: 0 1px 0 #D88A1D, 0 4px 10px rgba(216, 138, 29, 0.14);
}
```

### Secondary / Outline Button

```css
.secondary-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 100%; min-height: 56px; gap: var(--space-2);
  border: 1.5px solid var(--cream-border-strong); border-radius: 20px;
  background: rgba(255, 255, 255, 0.72);
  color: var(--brown-900);
  font-weight: 800; font-size: 16px;
}
```

### Bottom Navigation

```css
.bottom-nav {
  position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
  width: 100%; max-width: 430px;
  height: calc(70px + env(safe-area-inset-bottom, 0px));
  display: flex; align-items: flex-start; justify-content: space-around;
  background: rgba(255, 248, 236, 0.92);
  backdrop-filter: blur(12px);
  border-top: 1px solid rgba(240, 221, 196, 0.7);
  box-shadow: var(--shadow-nav);
  z-index: 50;
}
.bottom-nav-item.active {
  color: var(--brown-900);
  background: linear-gradient(180deg, #FFF4D2, #FFFFFF00);
}
```

## OMK HUD / Cockpit Theme

OMK의 CLI HUD와 Cockpit는 브라운 계열 터미널 테마 사용:

```
Primary:     #FFC83D (yellow CTA)
Secondary:   #D8AA72 (brown accent)
Background:  #2A170D (dark brown bg)
Surface:     #3A1F10 (card surfaces)
Text:        #FFF8EF (cream text)
Muted:       #8B6F59 (muted text)
Success:     #2F9B4A (green)
Error:       #E85D1F (orange-red)
Warning:     #B35C00 (amber)
Info:        #536D7A (slate)
```

## Asset Usage Matrix

Asset provenance gate: 이 표는 디자인 의도만 설명한다. 아래 `public/assets` 항목은 provenance가 기록될 때까지 source-only이며, package/release 산출물에는 `readmeasset/` 및 `docs/assets/`처럼 provenance가 확인된 선별 에셋만 포함한다.


| OMK Surface | Assets Used |
|-------------|-------------|
| HUD | `cat-judge.png` (mascot, small) |
| Cockpit | `cat-judge.png` (hero), `paw-rating.png` (status icon) |
| Dashboard | `logo-600x600.png` (logo), `verdict-*.png` (status states) |
| Run Status | verdict images mapped to run states: `adopt`=pass, `confiscated`=error, `jail`=fail, `wait`=pending |
| Social Preview | `thumbnail-1100x800.png`, `cat-gavel.png` |
| Landing Page | `references/landing-and-form.png` (reference) |
| Error States | `cat-gavel.png` (judge gavel for error/blocked) |

## Animation Presets

```css
.animate-fadeInUp    { animation: fadeInUp 0.6s cubic-bezier(0.22,1,0.36,1) both; }
.animate-bounceIn    { animation: bounceIn 0.72s cubic-bezier(0.2,0.85,0.25,1.18) both; }
.animate-float       { animation: float 3s ease-in-out infinite; }
.animate-paw-pop     { animation: paw-pop 160ms ease-out; }
.animate-card-3d     { animation: card-3d-tilt 0.7s cubic-bezier(0.2,0.85,0.25,1.1) both; }
.animate-scale-in    { animation: scale-in-bounce 0.65s cubic-bezier(0.2,0.85,0.25,1.18) both; }
.animate-glow-pulse  { animation: glow-pulse 2s ease-in-out infinite; }
.animate-count-pop   { animation: count-pop 0.5s cubic-bezier(0.2,0.85,0.25,1.15) both; }

/* Stagger delays */
.stagger-1 { animation-delay: 0.06s; }
.stagger-2 { animation-delay: 0.12s; }
.stagger-3 { animation-delay: 0.18s; }
.stagger-4 { animation-delay: 0.24s; }
.stagger-5 { animation-delay: 0.30s; }
```

## Rules

1. **Use tokens before inventing new values** — 모든 색상/간격/쉐도우는 CSS 변수 참조
2. **Yellow (`#FFC83D`) is the CTA hero** — 주요 액션 버튼에만 사용
3. **Brown (`#3A1F10`) is text authority** — 모든 본문/헤딩 텍스트
4. **Cream (`#FFF8EF`) is the page soul** — 메인 배경, 절대 순수 흰색 사용 금지
5. **Orange (`#F05A28`) is emphasis only** — 경고/강조/수치 표시에 제한적 사용
6. **Rounded everything** — 20px+ border-radius on cards, pill buttons
7. **44px minimum touch targets** — 모바일/태블릿 터치 대응
8. **Cat judge is mascot** — `cat-judge.png`를 OMK 브랜드 아이덴티티로 사용
9. **Reduced motion respected** — `prefers-reduced-motion` 미디어 쿼리 필수
10. **Color never the only indicator** — 상태 배지에 텍스트 + 색상 함께 사용

## Accessibility

- 모든 인터랙티브 요소에 `aria-label` / `aria-current` 제공
- 포커스 링: brown border + yellow glow (`outline: 3px solid rgba(255, 189, 46, 0.42)`)
- 최소 터치 타겟 44px
- `prefers-reduced-motion: reduce` 전역 적용
- 색상 대비: WCAG AA 이상 (brown-on-cream = 10.5:1)

## References

| Page | Reference Image |
|------|----------------|
| 대시보드 | `references/dashboard.png` |
| 랜딩 + 입력폼 | `references/landing-and-form.png` |
| 마이페이지 | `references/my-page.png` |
| 기록 | `references/records.png` |
| 결과 | `references/result.png` |
