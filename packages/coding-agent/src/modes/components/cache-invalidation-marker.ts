import type { Usage } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";

/**
 * Minimum cached prefix (read + write) the previous turn must have established
 * before a collapse on the current turn counts as an invalidation. Filters out
 * tiny contexts and providers below the cacheable-prefix floor, where a zero
 * `cacheRead` is expected rather than a reset.
 */
const MIN_CACHE_FOOTPRINT = 2048;

/** A prompt-cache invalidation detected from a turn's usage. */
export interface CacheInvalidation {
	/** Prompt tokens the cold turn had to (re)process instead of reading from cache. */
	reprocessedTokens: number;
}

/**
 * Decide whether `current` turn lost the prompt cache that `prev` established.
 *
 * The provider reports a warm prefix as `cacheRead`; a model/thinking/tool/
 * system-prompt change (or a history rewrite) breaks the prefix, so the next
 * request reads nothing from cache and re-pays for the whole prompt. We detect
 * that as: the previous turn cached a meaningful prefix, yet this turn's
 * `cacheRead` collapsed to zero while it still reprocessed a non-trivial prompt.
 * Returns `undefined` (no marker) for the first turn, tiny contexts, turns
 * that reused any cache, and — crucially — turns on providers with *implicit*
 * best-effort caching. Only an explicit, prefix-controlled cache (Anthropic /
 * Bedrock `cache_control`) re-creates the prefix on a cold turn (`cacheWrite >
 * 0`); implicit caches (Google / OpenAI / Fireworks) report `cacheWrite: 0` and
 * drop `cacheRead` to zero intermittently as routine propagation noise that
 * self-heals the next turn, so flagging it would be a false positive.
 */
export function detectCacheInvalidation(prev: Usage | undefined, current: Usage): CacheInvalidation | undefined {
	if (!prev) return undefined;
	const prevFootprint = prev.cacheRead + prev.cacheWrite;
	if (prevFootprint < MIN_CACHE_FOOTPRINT) return undefined;
	// Any cache reuse this turn means the prefix survived (at least partly).
	if (current.cacheRead > 0) return undefined;
	// Only an explicit, prefix-controlled cache re-creates the prefix on a cold
	// turn — Anthropic/Bedrock report that as `cacheWrite`. Implicit best-effort
	// caches (Google/OpenAI/Fireworks) report `cacheWrite: 0` and drop `cacheRead`
	// to zero intermittently as propagation noise, not a real invalidation.
	if (current.cacheWrite <= 0) return undefined;
	const reprocessedTokens = current.cacheWrite + current.input;
	if (reprocessedTokens < MIN_CACHE_FOOTPRINT) return undefined;
	return { reprocessedTokens };
}

const CACHE_INVALIDATION_RULE_WIDTH = 10;

/**
 * Slim left-aligned divider rendered above an assistant turn whose request lost
 * the prompt cache. Mirrors the compaction divider's banner styling but spans
 * only a short rule plus label (not the full width) and carries no expandable
 * detail:
 *
 *   ────────── ⊘ cache miss · 50.9k tokens
 */
export class CacheInvalidationMarkerComponent implements Component {
	#cache?: { width: number; lines: string[] };

	constructor(private readonly info: CacheInvalidation) {}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const icon = theme.icon.cacheMiss;
		const head = icon ? `${icon} cache miss` : "cache miss";
		const tokens = this.info.reprocessedTokens;
		const label = tokens > 0 ? `${head} ${theme.sep.dot.trim()} ${formatNumber(tokens)} tokens` : head;
		const labelWidth = Bun.stringWidth(label, { countAnsiEscapeCodes: false });
		const ruleWidth = Math.min(CACHE_INVALIDATION_RULE_WIDTH, width - labelWidth - 1);
		if (ruleWidth < 1) {
			// Too narrow to frame — emit the bare label.
			return theme.fg("muted", label);
		}
		return `${theme.fg("dim", theme.tree.horizontal.repeat(ruleWidth))} ${theme.fg("muted", label)}`;
	}
}
