import { commandConsumed } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const dumpCommand: AcpBuiltinCommandSpec = {
	name: "dump",
	description: "Return full transcript as plain text",
	handle: async (_command, runtime) => {
		const text = runtime.session.formatSessionAsText();
		await runtime.output(text || "No messages to dump yet.");
		return commandConsumed();
	},
};
