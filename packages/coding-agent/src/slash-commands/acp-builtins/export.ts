import { commandConsumed, errorMessage, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const exportCommand: AcpBuiltinCommandSpec = {
	name: "export",
	description: "Export session to HTML file",
	inputHint: "[path]",
	handle: async (command, runtime) => {
		const arg = command.args.trim();
		// Match the interactive `/export` behavior: clipboard aliases are not a
		// valid export target. Without this, the literal value (`copy`,
		// `--copy`, `clipboard`) is passed to `exportToHtml` and becomes the
		// output filename.
		if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
			return usage("Use /dump to copy the session to clipboard.", runtime);
		}
		try {
			const filePath = await runtime.session.exportToHtml(arg || undefined);
			await runtime.output(`Session exported to: ${filePath}`);
			return commandConsumed();
		} catch (err) {
			return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
		}
	},
};
