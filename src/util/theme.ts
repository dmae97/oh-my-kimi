/**
 * OMK Theme — Backward-compatible barrel (migrated from God Module)
 *
 * Previous monolithic implementation split into focused modules under src/theme/:
 *   ansi.ts     — ANSI escape helpers & text sanitization
 *   colors.ts   — Brand color styles & semantic status
 *   layout.ts   — Headers, panels, boxes, gauges
 *   metrics.ts  — Metrics panels & system usage
 *   parallel.ts — Parallel execution UI, badges, banners
 *   hud-theme.ts— HudTheme contract implementation
 *
 * All exports preserved for backward compatibility.
 */

export * from "../theme/index.js";
