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
		await runtime.sessionManager.flush();
		await runtime.sessionManager.moveTo(resolvedPath);
		setProjectDir(resolvedPath);
		await runtime.notifyTitleChanged?.();
		await runtime.output(`Session moved to ${runtime.sessionManager.getCwd()}.`);
		return commandConsumed();
	},
};
