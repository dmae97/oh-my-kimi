import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProjectDir } from "@oh-my-pi/pi-utils";
import { commandConsumed, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const moveCommand: AcpBuiltinCommandSpec = {
	name: "move",
	description: "Move the current session file",
	inputHint: "<path>",
	handle: async (command, runtime) => {
		if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
		if (!command.args) return usage("Usage: /move <path>", runtime);
		const resolvedPath = path.resolve(runtime.cwd, command.args);
		let isDirectory: boolean;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
		}
		if (!isDirectory) return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
		try {
			await runtime.sessionManager.flush();
			await runtime.sessionManager.moveTo(resolvedPath);
		} catch (err) {
			return usage(`Move failed: ${err instanceof Error ? err.message : String(err)}`, runtime);
		}
		setProjectDir(resolvedPath);
		// Reload plugin/capability caches so the next prompt sees commands and
		// capabilities scoped to the new cwd.
		await runtime.reloadPlugins();
		await runtime.notifyTitleChanged?.();
		await runtime.output(`Session moved to ${runtime.sessionManager.getCwd()}.`);
		return commandConsumed();
	},
};
