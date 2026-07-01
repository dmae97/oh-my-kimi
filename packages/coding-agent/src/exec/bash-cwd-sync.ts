import * as fs from "node:fs/promises";
import * as path from "node:path";

import { logger } from "@oh-my-pi/pi-utils";

import { type BashResult, executeBash } from "./bash-executor";

const CWD_QUERY_TIMEOUT_MS = 5_000;

export interface BashCwdSyncOptions {
	/** Persistent bash session key whose current directory should be queried. */
	sessionKey: string;
	/** Session cwd before the user bash command ran. */
	currentCwd: string;
	/** Run through the configured user shell when the original command did. */
	useUserShell?: boolean;
	/** Apply the discovered cwd to the owning session. */
	applyCwd: (cwd: string) => Promise<void>;
}

/** Synchronize a persistent bash session's PWD back into the owning session. */
export async function syncBashSessionCwd(options: BashCwdSyncOptions): Promise<string | null> {
	let result: BashResult;
	try {
		result = await executeBash("pwd", {
			sessionKey: options.sessionKey,
			timeout: CWD_QUERY_TIMEOUT_MS,
			useUserShell: options.useUserShell,
		});
	} catch (error) {
		logger.debug("Failed to query bash session cwd", { error: String(error) });
		return null;
	}

	if (result.cancelled || result.exitCode !== 0) return null;
	const nextCwd = result.output
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)
		.at(-1);
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
