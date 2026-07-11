import type { Usage } from "@oh-my-pi/pi-ai";
import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";

/** Below this the rate is nonsense (cached/instant responses yield absurd tok/s). */
const MIN_DURATION_MS = 100;

export function createUsageRowBlock(usage: Usage, durationMs?: number, ttftMs?: number): Container {
	const totalInput = usage.input + usage.cacheWrite;
	const parts: string[] = [];
	parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
	parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
	if (usage.cacheRead > 0) {
		parts.push(`${theme.icon.cache} ${formatNumber(usage.cacheRead)}`);
	}
	if (ttftMs && ttftMs > 0) {
		parts.push(`${theme.icon.time} ${(ttftMs / 1000).toFixed(1)}s`);
	}
	if (durationMs && durationMs > MIN_DURATION_MS && usage.output > 0) {
		// TPS over the total request duration — the post-TTFT window undercounts
		// generation time when reasoning tokens are hidden before the first
		// visible byte, inflating the rate.
		const tokPerSec = (usage.output / durationMs) * 1000;
		parts.push(`${theme.icon.throughput} ${tokPerSec.toFixed(1)}/s`);
	}
	const block = new Container();
	block.addChild(new Spacer(1));
	block.addChild(new Text(theme.fg("dim", parts.join("  ")), 1, 0));
	return block;
}
