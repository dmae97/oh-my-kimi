/**
 * Default-on gate for the verified bash adapter (opt-out via OMK_VERIFIED_BASH=0).
 *
 * Mirrors ADR-OMP-009: the receipt-bound path is the default experience; the
 * exact legacy unverified path remains available as a byte-identical rollback.
 */
import { spawnSync } from "node:child_process";
import { isNormalizedArtifactPath } from "../guardrails/workspace-fingerprint.ts";
import type { WorkspaceScope } from "../types/evidence.ts";

export function isVerifiedBashEnabled(env?: Record<string, string | undefined>): boolean {
	const source: Record<string, string | undefined> = env ?? process.env;
	return source.OMK_VERIFIED_BASH !== "0";
}

// ---------------------------------------------------------------------------
// Git-aware session workspace scope (bounded, TTL-cached)
// ---------------------------------------------------------------------------

const SCOPE_TTL_MS = 1_000;
const SCOPE_CACHE_MAX = 8;
const SCOPE_MAX_PATHS = 32;
const GIT_TIMEOUT_MS = 1_500;

const scopeCache = new Map<string, { at: number; scope: WorkspaceScope }>();

/**
 * Workspace scope for session bash receipts. Inside a git worktree the scope
 * root is the toplevel and `artifactPaths` is the current dirty set (staged,
 * modified, untracked; capped and sorted), which lets `captureWorkspaceFingerprint`
 * bind HEAD plus a scope-limited dirty digest. Outside git, falls back to an
 * empty artifact set under `cwd`. Never throws.
 */
export function resolveSessionWorkspaceScope(cwd: string, options?: { maxPaths?: number }): WorkspaceScope {
	const cached = scopeCache.get(cwd);
	if (cached && Date.now() - cached.at < SCOPE_TTL_MS) return cached.scope;
	const scope = computeSessionWorkspaceScope(cwd, options?.maxPaths ?? SCOPE_MAX_PATHS);
	if (scopeCache.size >= SCOPE_CACHE_MAX) {
		const oldest = scopeCache.keys().next().value;
		if (oldest !== undefined) scopeCache.delete(oldest);
	}
	scopeCache.set(cwd, { at: Date.now(), scope });
	return scope;
}

function computeSessionWorkspaceScope(cwd: string, maxPaths: number): WorkspaceScope {
	try {
		const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (top.status !== 0 || typeof top.stdout !== "string") return { root: cwd, artifactPaths: [] };
		const root = top.stdout.trim();
		if (root.length === 0) return { root: cwd, artifactPaths: [] };
		// File-granular untracked listing: -unormal emits untracked directories as
		// `dir/`, whose trailing slash fails assertNormalizedArtifactPath downstream
		// and kills every verified bash call in the session.
		const status = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 4 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (status.status !== 0 || !status.stdout) return { root, artifactPaths: [] };
		const fields = status.stdout.toString("utf8").split("\0");
		const paths: string[] = [];
		for (let index = 0; index < fields.length; index++) {
			const field = fields[index];
			if (field.length < 4) continue;
			const xy = field.slice(0, 2);
			if (xy === "!!") continue;
			if (xy.includes("R") || xy.includes("C")) index++; // rename/copy: consume the source path field too
			const artifact = field.slice(3);
			// Keep only entries the fingerprint can bind. This drops trailing-slash
			// survivors (untracked nested repositories, whose contents are outside
			// the parent's dirty digest) and names the receipt parser rejects, such
			// as a mangled `\\wsl.localhost\...` directory containing a backslash.
			if (isNormalizedArtifactPath(artifact)) paths.push(artifact);
		}
		const artifactPaths = [...new Set(paths)].sort().slice(0, maxPaths);
		return { root, artifactPaths };
	} catch {
		return { root: cwd, artifactPaths: [] };
	}
}
