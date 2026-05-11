import { commandConsumed, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const forceCommand: AcpBuiltinCommandSpec = {
	name: "force",
	description: "Force next turn to use a specific tool",
	inputHint: "<tool-name> [prompt]",
	aliases: ["force:"],
	handle: async (command, runtime) => {
		const spaceIdx = command.args.indexOf(" ");
		const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
		const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
		if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
		runtime.session.setForcedToolChoice(toolName);
		await runtime.output(`Next turn forced to use ${toolName}.`);
		return prompt ? { prompt } : commandConsumed();
	},
};
