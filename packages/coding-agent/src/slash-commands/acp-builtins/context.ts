import { computeContextBreakdown } from "../../modes/utils/context-usage";
import { renderAsciiBar } from "./format";
import { commandConsumed } from "./shared";
import type { AcpBuiltinCommandRuntime, AcpBuiltinCommandSpec } from "./types";

function getContext(runtime: AcpBuiltinCommandRuntime): string {
	try {
		const breakdown = computeContextBreakdown(runtime.session);
		if (breakdown.contextWindow <= 0) {
			return "Context usage is unavailable: no model is selected for this session.";
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const lines = [`Context window: ${breakdown.contextWindow} tokens (${usedPct}% used)`];
		for (const category of breakdown.categories) {
			if (category.tokens === 0) continue;
			const fraction = category.tokens / breakdown.contextWindow;
			lines.push(`  ${category.label.padEnd(16)} ${renderAsciiBar(fraction)}  ${category.tokens} tokens`);
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
			lines.push(
				`  ${"Auto-compact buf".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.autoCompactBufferTokens} tokens`,
			);
		}
		if (breakdown.freeTokens > 0) {
			const fraction = breakdown.freeTokens / breakdown.contextWindow;
			lines.push(`  ${"Free".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.freeTokens} tokens`);
		}
		return lines.join("\n");
	} catch {
		const usage = runtime.session.getContextUsage();
		if (!usage) return "Context usage is unavailable.";
		return ["Context", `Window: ${usage.contextWindow}`, `Used: ${usage.tokens ?? 0}`].join("\n");
	}
}

export const contextCommand: AcpBuiltinCommandSpec = {
	name: "context",
	description: "Show context usage",
	handle: async (_command, runtime) => {
		await runtime.output(getContext(runtime));
		return commandConsumed();
	},
};
