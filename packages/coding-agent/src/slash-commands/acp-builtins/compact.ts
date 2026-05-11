import { commandConsumed } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const compactCommand: AcpBuiltinCommandSpec = {
	name: "compact",
	description: "Compact the conversation",
	inputHint: "[focus instructions]",
	handle: async (command, runtime) => {
		const before = runtime.session.getContextUsage?.();
		const beforeTokens = before?.tokens;
		await runtime.session.compact(command.args || undefined);
		const after = runtime.session.getContextUsage?.();
		const afterTokens = after?.tokens;
		if (beforeTokens != null && afterTokens != null) {
			const saved = beforeTokens - afterTokens;
			await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
		} else {
			await runtime.output("Compaction complete.");
		}
		return commandConsumed();
	},
};
