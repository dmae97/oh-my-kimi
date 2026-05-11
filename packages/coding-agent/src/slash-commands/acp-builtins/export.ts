import { commandConsumed, errorMessage, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const exportCommand: AcpBuiltinCommandSpec = {
	name: "export",
	description: "Export session to HTML file",
	inputHint: "[path]",
	handle: async (command, runtime) => {
		try {
			const filePath = await runtime.session.exportToHtml(command.args || undefined);
			await runtime.output(`Session exported to: ${filePath}`);
			return commandConsumed();
		} catch (err) {
			return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
		}
	},
};
