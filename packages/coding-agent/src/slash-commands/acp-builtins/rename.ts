import { commandConsumed, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const renameCommand: AcpBuiltinCommandSpec = {
	name: "rename",
	description: "Rename the current session",
	inputHint: "<title>",
	handle: async (command, runtime) => {
		if (!command.args) return usage("Usage: /rename <title>", runtime);
		const ok = await runtime.sessionManager.setSessionName(command.args, "user");
		if (!ok) {
			await runtime.output("Session name not changed (a user-set name takes precedence).");
			return commandConsumed();
		}
		await runtime.notifyTitleChanged?.();
		await runtime.output(`Session renamed to ${command.args}.`);
		return commandConsumed();
	},
};
