/**
 * Bordered output container with optional header and sections.
 */
import { ImageProtocol, padding, TERMINAL, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Theme } from "../modes/theme/theme";
import { getSixelLineMask } from "../utils/sixel";
import type { State } from "./types";
import type { RenderCache } from "./utils";
import { getStateBgColor, Hasher, padToWidth, truncateToWidth } from "./utils";

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: string[] }>;
	width: number;
	applyBg?: boolean;
	/** Animate the border with a sweeping dark segment (pending/running state). */
	animate?: boolean;
}

const BORDER_SHIMMER_TICK_MS = 16;
/** Duration of one full left↔right↔left bounce of the bottom-edge segment, in
 * ms. Position is derived from the wall clock against this fixed cycle so a
 * resize only nudges the segment proportionally instead of teleporting it. */
const BORDER_BOUNCE_MS = 3000;
/** Length, in border cells, of the moving segment. */
const BORDER_SEGMENT_LEN = 8;

/**
 * Monotonic frame counter for animated borders, quantized to the TUI's ~16ms
 * render cap so the cache key advances once per ~60fps frame — fine enough for a
 * smooth segment sweep, coarse enough to coalesce multiple render passes that
 * land inside the same frame.
 */
export function borderShimmerTick(): number {
	return Math.floor(Date.now() / BORDER_SHIMMER_TICK_MS);
}

/** Ease-in-out so the segment decelerates into and accelerates out of each wall. */
function easeInOutQuad(t: number): number {
	return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * Column of the travelling segment's center on the bottom edge for a box of
 * inner width `W` at time `now`. The segment bounces left → right → left across
 * the bottom border: a triangle wave over one full there-and-back cycle, eased
 * per leg so it slows as it nears each wall before reversing. Position is
 * derived from the wall clock against a fixed cycle, so a resize shifts the
 * center proportionally — no reset.
 */
export function borderSegmentHeadCol(W: number, now: number): number {
	if (W <= 1) return 0;
	const phase = (((now % BORDER_BOUNCE_MS) + BORDER_BOUNCE_MS) % BORDER_BOUNCE_MS) / BORDER_BOUNCE_MS;
	// Triangle: 0→1 rightward over the first half, 1→0 leftward over the second.
	const leg = phase < 0.5 ? phase * 2 : 2 - phase * 2;
	return easeInOutQuad(leg) * (W - 1);
}

/**
 * Scale a truecolor foreground escape toward black by `factor`. Returns
 * undefined for 256-color escapes (no RGB to scale) so callers fall back to a
 * dimmer theme color.
 */
function darkenFgAnsi(ansi: string, factor: number): string | undefined {
	const m = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
	if (!m) return undefined;
	const r = Math.round(Number(m[1]) * factor);
	const g = Math.round(Number(m[2]) * factor);
	const b = Math.round(Number(m[3]) * factor);
	return `\x1b[38;2;${r};${g};${b}m`;
}

type BlockRow =
	| { kind: "bar"; leftChar: string; rightChar: string; label?: string; meta?: string }
	| { kind: "bottom"; leftChar: string; rightChar: string }
	| { kind: "content"; inner: string }
	| { kind: "sixel"; raw: string };

export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	const { header, headerMeta, state, sections = [], width, applyBg = true } = options;
	const h = theme.boxSharp.horizontal;
	const v = theme.boxSharp.vertical;
	const cap = h.repeat(3);
	const lineWidth = Math.max(0, width);
	// Border colors: running/pending use accent, success uses dim (gray), error/warning keep their colors
	const borderColor: "error" | "warning" | "accent" | "dim" =
		state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "dim";
	const border = (text: string) => theme.fg(borderColor, text);
	const bgFn = (() => {
		if (!state || !applyBg) return undefined;
		const bgAnsi = theme.getBgAnsi(getStateBgColor(state));
		// Keep block background stable even if inner content contains SGR resets (e.g. "\x1b[0m"),
		// which would otherwise clear the outer background mid-line.
		return (text: string) => {
			const stabilized = text
				.replace(/\x1b\[(?:0)?m/g, m => `${m}${bgAnsi}`)
				.replace(/\x1b\[49m/g, m => `${m}${bgAnsi}`);
			return `${bgAnsi}${stabilized}\x1b[49m`;
		};
	})();

	const contentWidth = Math.max(0, lineWidth - visibleWidth(`${v} `) - visibleWidth(v));

	// ── Layout pass: collect row descriptors so the border perimeter length is
	// known before the moving segment is positioned. ──
	const rows: BlockRow[] = [];
	rows.push({
		kind: "bar",
		leftChar: theme.boxSharp.topLeft,
		rightChar: theme.boxSharp.topRight,
		label: header,
		meta: headerMeta,
	});

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (const section of normalizedSections) {
		if (section.label) {
			rows.push({
				kind: "bar",
				leftChar: theme.boxSharp.teeRight,
				rightChar: theme.boxSharp.teeLeft,
				label: section.label,
			});
		}
		const allLines = section.lines.flatMap(l => l.split("\n"));
		const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const line = allLines[lineIndex]!;
			if (sixelLineMask?.[lineIndex]) {
				rows.push({ kind: "sixel", raw: line });
				continue;
			}
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				const innerPadding = padding(Math.max(0, contentWidth - visibleWidth(wrappedLine)));
				rows.push({ kind: "content", inner: `${wrappedLine}${innerPadding}` });
			}
		}
	}

	rows.push({ kind: "bottom", leftChar: theme.boxSharp.bottomLeft, rightChar: theme.boxSharp.bottomRight });

	const H = rows.length;
	const W = lineWidth;
	const animate = (options.animate ?? false) && (state === "running" || state === "pending") && W >= 2 && H >= 2;

	// ── Segment geometry: one dark run bounces left ↔ right along the bottom
	// edge only. The top, interior separators, and side borders stay the flat
	// accent color. ──
	const segLen = animate ? Math.min(BORDER_SEGMENT_LEN, W) : 0;
	const head = animate ? borderSegmentHeadCol(W, Date.now()) : 0;
	const segHalf = segLen / 2;
	const segAnsi = animate ? (darkenFgAnsi(theme.getFgAnsi(borderColor), 0.4) ?? theme.getFgAnsi("borderMuted")) : "";
	const seg = (text: string) => `${segAnsi}${text}\x1b[39m`;

	// A bottom-edge column is lit when it lies within half a segment of the
	// travelling center.
	const isLit = (col: number): boolean => Math.abs(col - head) < segHalf;
	// Color a run of bottom-edge glyphs starting at column `startCol`, grouping
	// consecutive same-state cells so each run emits a single escape pair.
	const colorEdge = (glyphs: string, startCol: number): string => {
		let out = "";
		let runLit: boolean | null = null;
		let buf = "";
		for (let i = 0; i < glyphs.length; i++) {
			const lit = isLit(startCol + i);
			if (lit !== runLit) {
				if (runLit !== null) out += (runLit ? seg : border)(buf);
				buf = "";
				runLit = lit;
			}
			buf += glyphs[i];
		}
		if (runLit !== null) out += (runLit ? seg : border)(buf);
		return out;
	};

	const renderBar = (row: { leftChar: string; rightChar: string; label?: string; meta?: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		if (lineWidth <= 0) return border(leftGlyphs) + border(rightGlyph);
		const labelText = [row.label, row.meta].filter(Boolean).join(theme.sep.dot);
		const rawLabel = labelText ? ` ${labelText} ` : " ";
		const leftWidth = visibleWidth(leftGlyphs);
		const rightWidth = visibleWidth(rightGlyph);
		const maxLabelWidth = Math.max(0, lineWidth - leftWidth - rightWidth);
		const trimmedLabel = truncateToWidth(rawLabel, maxLabelWidth);
		const labelWidth = visibleWidth(trimmedLabel);
		const fillCount = Math.max(0, lineWidth - leftWidth - labelWidth - rightWidth);
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${trimmedLabel}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const renderBottom = (row: { leftChar: string; rightChar: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
		const fillGlyphs = h.repeat(fillCount);
		if (!animate) return `${border(leftGlyphs)}${border(fillGlyphs)}${border(rightGlyph)}`;
		const leftStr = colorEdge(leftGlyphs, 0);
		const fillStr = colorEdge(fillGlyphs, visibleWidth(leftGlyphs));
		const rightStr = colorEdge(rightGlyph, lineWidth - visibleWidth(rightGlyph));
		return `${leftStr}${fillStr}${rightStr}`;
	};

	const renderContent = (inner: string): string => `${border(`${v} `)}${inner}${border(v)}`;

	const lines: string[] = [];
	for (let r = 0; r < H; r++) {
		const row = rows[r]!;
		if (row.kind === "sixel") {
			lines.push(row.raw);
			continue;
		}
		const line =
			row.kind === "bar" ? renderBar(row) : row.kind === "bottom" ? renderBottom(row) : renderContent(row.inner);
		lines.push(padToWidth(line, lineWidth, bgFn));
	}

	return lines;
}

/**
 * Cached wrapper around `renderOutputBlock`.
 *
 * Since output blocks are re-rendered on every frame (via `render(width)` closures),
 * but their content rarely changes, this cache avoids redundant `visibleWidth()` and
 * `padding()` computations on ~99% of render calls.
 */
export class CachedOutputBlock {
	#cache?: RenderCache;

	/** Render with caching. Returns cached result if options haven't changed. */
	render(options: OutputBlockOptions, theme: Theme): string[] {
		const key = this.#buildKey(options);
		if (this.#cache?.key === key) return this.#cache.lines;
		const lines = renderOutputBlock(options, theme);
		this.#cache = { key, lines };
		return lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const h = new Hasher();
		h.u32(options.width);
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.bool(options.applyBg ?? true);
		h.bool(options.animate ?? false);
		if (options.animate) h.u32(borderShimmerTick());
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}
