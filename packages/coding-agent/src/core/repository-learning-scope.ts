import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";

const SCOPE_VERSION = "repo-v1";

export interface RepositoryRouterLearningPaths {
	readonly scopeId: string;
	readonly ledgerPath: string;
	readonly biasSnapshotPath: string;
}

function canonicalDirectory(cwd: string): string {
	const absolute = resolve(cwd);
	try {
		return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
	} catch {
		return absolute;
	}
}

function findRepositoryRoot(cwd: string): string {
	let current = canonicalDirectory(cwd);
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return canonicalDirectory(cwd);
		current = parent;
	}
}

/** Opaque local scope; the raw repository/worktree path is never persisted. */
export function resolveRepositoryLearningScope(cwd: string): string {
	const root = findRepositoryRoot(cwd);
	const digest = createHash("sha256").update(`${SCOPE_VERSION}\0${root}`).digest("hex").slice(0, 32);
	return `${SCOPE_VERSION}-${digest}`;
}

/** Default ledger/snapshot paths isolated to one repository or git worktree. */
export function getRepositoryRouterLearningPaths(cwd: string, agentDir = getAgentDir()): RepositoryRouterLearningPaths {
	const scopeId = resolveRepositoryLearningScope(cwd);
	const directory = join(agentDir, "router-feedback", "repositories", scopeId);
	return {
		scopeId,
		ledgerPath: join(directory, "ledger.jsonl"),
		biasSnapshotPath: join(directory, "router-bias-snapshot.v4.json"),
	};
}
