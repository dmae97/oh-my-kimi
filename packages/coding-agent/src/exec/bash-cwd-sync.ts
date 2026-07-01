import * as fs from "node:fs/promises";
import * as path from "node:path";

import { logger } from "@oh-my-pi/pi-utils";

import type { BashResult } from "./bash-executor";

export interface BashCwdSyncOptions {
	/** Completed bash result whose native shell state carries the post-command cwd. */
	result: BashResult;
	/** Session cwd before the user bash command ran. */
	currentCwd: string;
	/** Apply the discovered cwd to the owning session. */
	applyCwd: (cwd: string) => Promise<void>;
}

/** Synchronize a completed bash command's native working directory back into the owning session. */
export async function syncBashSessionCwd(options: BashCwdSyncOptions): Promise<string | null> {
	const nextCwd = options.result.workingDir;
	if (!nextCwd || !path.isAbsolute(nextCwd)) return null;
	if (path.resolve(nextCwd) === path.resolve(options.currentCwd)) return null;

	try {
		const stat = await fs.stat(nextCwd);
		if (!stat.isDirectory()) return null;
		await options.applyCwd(nextCwd);
		return nextCwd;
	} catch (error) {
		logger.debug("Failed to apply bash session cwd", { cwd: nextCwd, error: String(error) });
		return null;
	}
}
