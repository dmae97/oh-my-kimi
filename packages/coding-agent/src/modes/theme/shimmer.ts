import { isSettingsInitialized, settings } from "../../config/settings";
import type { Theme, ThemeColor } from "./theme";

// ─── Classic sweep tunables ──────────────────────────────────────────────────
const CLASSIC_PADDING = 10;
const CLASSIC_SWEEP_MS = 1400;
const CLASSIC_BAND_HALF_WIDTH = 6;

// ─── KITT scanner tunables ───────────────────────────────────────────────────
// 1.5s round trip ≈ classic 1982 K.I.T.T. scanner cadence (~0.75s per direction).
const KITT_CYCLE_MS = 1500;
const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;

// ─── Tier thresholds ─────────────────────────────────────────────────────────
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

// ─── Raw ANSI codes ──────────────────────────────────────────────────────────
const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

type ShimmerTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;
type ShimmerMode = "classic" | "kitt" | "disabled";

type ShimmerPaletteTier = ThemeColor | { ansi: string };

function resolveTierAnsi(theme: ShimmerTheme, tier: ShimmerPaletteTier): string {
	return typeof tier === "string" ? theme.getFgAnsi(tier) : tier.ansi;
}

/** Three-tier color stack a shimmer character cycles through as the band sweeps. */
export interface ShimmerPalette {
	/** Color for chars outside / at the edge of the band (intensity < ~0.22). */
	low: ShimmerPaletteTier;
	/** Color for chars approaching the crest (~0.22 ≤ intensity < ~0.65). */
	mid: ShimmerPaletteTier;
	/** Color at the band's crest (intensity ≥ ~0.65). */
	high: ShimmerPaletteTier;
	/** Whether to bold the crest tier. Default `false`. */
	bold?: boolean;
}

/** One run of text that shares a palette inside a larger shimmer sweep. */
export interface ShimmerSegment {
	text: string;
	palette?: ShimmerPalette;
}

export const DEFAULT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "accent",
	bold: true,
};

// ─── Palette compilation cache ───────────────────────────────────────────────
// Resolving ANSI codes for every character was the dominant per-frame cost.
// We resolve once per (theme, palette) pair into ready-to-concat prefix/suffix
// strings, then coalesce same-tier runs at render time so each frame emits a
// handful of escape sequences instead of one per code point.
//
// The cache is stashed as a Symbol-keyed slot directly on the palette object
// — no module-level sidecar — and invalidates when the active Theme changes.
interface TierSeq {
	open: string;
	close: string;
}
interface CompiledPalette {
	low: TierSeq;
	mid: TierSeq;
	high: TierSeq;
}

const kCompiledFor = Symbol("shimmer.compiledFor");
const kCompiled = Symbol("shimmer.compiled");
interface PaletteCache {
	[kCompiledFor]?: ShimmerTheme;
	[kCompiled]?: CompiledPalette;
}

function compile(theme: ShimmerTheme, palette: ShimmerPalette): CompiledPalette {
	const p = palette as ShimmerPalette & PaletteCache;
	const cached = p[kCompiled];
	if (cached && p[kCompiledFor] === theme) return cached;
	const lowOpen = resolveTierAnsi(theme, palette.low);
	const midOpen = resolveTierAnsi(theme, palette.mid);
	const highColorOpen = resolveTierAnsi(theme, palette.high);
	const highOpen = palette.bold ? `${BOLD_OPEN}${highColorOpen}` : highColorOpen;
	const highClose = palette.bold ? `${BOLD_CLOSE}${FG_RESET}` : FG_RESET;
	const out: CompiledPalette = {
		low: { open: lowOpen, close: FG_RESET },
		mid: { open: midOpen, close: FG_RESET },
		high: { open: highOpen, close: highClose },
	};
	p[kCompiledFor] = theme;
	p[kCompiled] = out;
	return out;
}

// ─── Intensity profiles ──────────────────────────────────────────────────────
/** Smooth cosine bump sweeping left → right with edge padding. */
function classicIntensity(time: number, index: number, length: number): number {
	const period = length + CLASSIC_PADDING * 2;
	// Fractional position — kept un-floored so the band glides at the host's
	// frame rate instead of stepping discretely.
	const pos = ((time % CLASSIC_SWEEP_MS) / CLASSIC_SWEEP_MS) * period;
	const dist = Math.abs(index + CLASSIC_PADDING - pos);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

/**
 * Knight Rider K.I.T.T. scanner: a single bright head ping-pongs across the
 * bar with a quadratic-decay trail behind it. No leading glow — LEDs don't
 * predict the future.
 */
function kittIntensity(time: number, index: number, length: number): number {
	const range = length - 1;
	if (range <= 0) return 1;
	const phase = (time % KITT_CYCLE_MS) / KITT_CYCLE_MS;
	const goingRight = phase < 0.5;
	const head = goingRight ? phase * 2 * range : (1 - phase) * 2 * range;
	const delta = index - head;
	const abs = delta < 0 ? -delta : delta;
	if (abs <= KITT_HEAD_HALF) return 1;
	// Only chars *behind* the head light up — direction-dependent.
	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (t >= 1) return 0;
	const f = 1 - t;
	return f * f;
}

type Tier = "low" | "mid" | "high";

function tierFor(intensity: number): Tier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

function resolveMode(): ShimmerMode {
	if (!isSettingsInitialized()) return "classic";
	return settings.get("display.shimmer");
}

/** Whether shimmer animations are active (any mode other than `disabled`). */
export function shimmerEnabled(): boolean {
	return resolveMode() !== "disabled";
}

/**
 * Apply a shimmer sweep across one or more segments, treating them as a
 * single continuous string for band positioning. Each segment can supply
 * its own palette so the gradient stays in lockstep while the colors
 * differ.
 *
 * Performance shape (per call, dominant cost):
 *   - One `Date.now()` read.
 *   - One `compile()` lookup per segment (Symbol-keyed cache slot, hot path
 *     skipped after first frame).
 *   - One ANSI open/close pair per **run of same-tier chars**, not per char.
 *   - No per-char allocations beyond the run buffer.
 */
export function shimmerSegments(segments: readonly ShimmerSegment[], theme: ShimmerTheme): string {
	const mode = resolveMode();

	// Pre-scan: total code-point count (positions the band) and resolved palette.
	let total = 0;
	const perSeg: { chars: string[]; palette: ShimmerPalette }[] = [];
	for (const seg of segments) {
		const chars = Array.from(seg.text);
		total += chars.length;
		perSeg.push({ chars, palette: seg.palette ?? DEFAULT_SHIMMER_PALETTE });
	}
	if (total === 0) return "";

	// Disabled: no animation, no per-char work. Paint each segment in its mid
	// tier so the working line stays legible without movement.
	if (mode === "disabled") {
		let out = "";
		for (const { chars, palette } of perSeg) {
			const seq = compile(theme, palette).mid;
			out += `${seq.open}${chars.join("")}${seq.close}`;
		}
		return out;
	}

	const time = Date.now();
	const intensityFn = mode === "kitt" ? kittIntensity : classicIntensity;

	let out = "";
	let index = 0;
	for (const { chars, palette } of perSeg) {
		const compiled = compile(theme, palette);
		let runTier: Tier | null = null;
		let runBuf = "";
		for (let i = 0; i < chars.length; i++) {
			const tier = tierFor(intensityFn(time, index, total));
			if (tier !== runTier) {
				if (runTier !== null) {
					const seq = compiled[runTier];
					out += `${seq.open}${runBuf}${seq.close}`;
					runBuf = "";
				}
				runTier = tier;
			}
			runBuf += chars[i];
			index++;
		}
		if (runTier !== null && runBuf.length > 0) {
			const seq = compiled[runTier];
			out += `${seq.open}${runBuf}${seq.close}`;
		}
	}
	return out;
}

export function shimmerText(text: string, theme: ShimmerTheme, palette?: ShimmerPalette): string {
	return shimmerSegments([{ text, palette }], theme);
}
