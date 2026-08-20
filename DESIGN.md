# OMK Brand Design System

This document governs the repository README, landing surfaces, and public brand assets. `packages/coding-agent/DESIGN.md` remains the source of truth for the terminal UI.

## 1. Atmosphere & Identity

OMK feels like a calm, auditable command center: technical enough to trust, restrained enough to read, and never chaotic. The signature is **OMK Girl at the control plane**—an adult fictional operator who makes scope, routing, evidence, and recovery visible. Cyberpunk cues come from precise instrumentation, matte materials, scanlines, and controlled light rather than neon clutter.

## 2. Color

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Surface/primary | `--surface-primary` | `#07090D` | Brand canvas and hero background |
| Surface/secondary | `--surface-secondary` | `#111722` | Panels and terminal surfaces |
| Text/primary | `--text-primary` | `#F4F5E9` | Headlines and body copy |
| Text/secondary | `--text-secondary` | `#A8B1BD` | Captions and supporting copy |
| Accent/primary | `--accent-primary` | `#C8F031` | Focus, verified state, primary route |
| Accent/info | `--accent-info` | `#53D7FF` | Secondary route and recovery state |
| Status/error | `--status-error` | `#FF5C6C` | Blocking failures only |

Use off-black and charcoal for at least 80% of generated brand imagery. Lime is the single dominant accent; cyan supports hierarchy but never competes with lime. Status must always include text or shape, not color alone. Normal text must meet WCAG AA contrast.

## 3. Typography

| Level | Character | Usage |
| --- | --- | --- |
| Display | Condensed grotesk, 700, tight tracking | `OMK//CONTROL` and feature words |
| Heading | System sans, 600–700 | README section hierarchy |
| Body | System sans, 400, generous line height | Explanations and guides |
| Mono | IBM Plex Mono or platform monospace | Commands, receipts, labels |

README prose stays in GitHub's native typography. Generated images use at most one condensed display face plus one monospace face. Image text must be sparse, large, and duplicated in adjacent Markdown when it carries product meaning.

## 4. Spacing & Layout

All authored web spacing follows a 4 px base unit. Public documentation uses a wide hero, then a narrow reading column with short sections. Brand images reserve at least 8% safe space around essential text and faces. README media must remain responsive (`width="100%"` or a bounded intrinsic width) and avoid horizontal overflow.

Preferred asset ratios:

- README hero: `2:1`
- Feature still or GIF frame: `3:2`
- TUI evidence: native screenshot ratio

## 5. Components

### README hero

- **Structure:** one wide OMK Girl image, product title, one-line positioning, essential badges.
- **Variants:** static PNG only at the top; never autoplay a hero animation.
- **Accessibility:** meaningful alt text names OMK Girl and the control-plane purpose.
- **Media budget:** target ≤ 2.5 MB.

### Control loop demo

- **Structure:** four slow frames—Scope, Route, Verify, Replay—with an adjacent textual summary.
- **States:** every frame remains readable independently.
- **Accessibility:** frame changes no faster than once per second; no flashing; static hero provides an equivalent reduced-motion path.
- **Media budget:** target ≤ 4 MB.

### Evidence image

- **Structure:** one product screenshot with explicit width and descriptive alt text.
- **Rule:** screenshots prove real behavior; generated artwork explains concepts. Never present generated UI as a literal product screenshot.

## 6. Motion & Interaction

README animation is informational, not decorative. The control-loop GIF holds each frame for at least 1.25 seconds, uses hard cuts or gentle fades, and flashes fewer than three times per second. Because GitHub README cannot reliably honor `prefers-reduced-motion` or expose pause controls, keep the static hero before the GIF and duplicate all feature meaning in text. Web surfaces animate only `transform`, `opacity`, or `filter` and provide a reduced-motion path.

## 7. Depth & Surface

Use a **tonal-shift** strategy: depth comes from off-black layers, matte glass, restrained linework, and selective lime/cyan emission. Avoid generic purple-blue AI gradients, stacked glass cards, random glow, floating icon clouds, cheap neon, and dense fake dashboards. Grain and scanlines stay subtle enough that text and faces remain clear.
