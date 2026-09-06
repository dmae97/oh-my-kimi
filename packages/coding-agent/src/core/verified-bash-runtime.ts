/**
 * Default-on gate for the verified bash adapter (opt-out via OMK_VERIFIED_BASH=0).
 *
 * Mirrors ADR-OMP-009: the receipt-bound path is the default experience; the
 * exact legacy unverified path remains available as a byte-identical rollback.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
/** Domain separator so an excluded-set digest can never collide with another digest. */
const EXCLUDED_SET_DOMAIN = "omk:evidence:session-scope-excluded:v1\0";

const scopeCache = new Map<string, { at: number; report: SessionWorkspaceScopeReport }>();

/**
 * Why a session scope is not a complete view of the workspace dirty set.
 *
 * `unavailable` is not `complete`: outside a worktree, or when git cannot be
 * read, nothing was enumerated, so an empty artifact set is an absence of
 * evidence rather than evidence of a clean tree.
 */
export type SessionScopeCompleteness = "complete" | "partial_truncated" | "partial_excluded" | "unavailable";

/**
 * A session scope plus what it could not bind.
 *
 * The scope drops dirty paths two ways — a hard cap for availability, and the
 * normalized-path filter the receipt parser forces — and both were previously
 * silent, so a receipt built on a partial view read exactly like one that saw
 * the whole workspace. Dropping stays deliberate; hiding it was the defect.
 */
export interface SessionWorkspaceScopeReport {
	readonly scope: WorkspaceScope;
	/** Unique dirty entries git reported, before the cap and the path filter. */
	readonly totalDirtyPathCount: number;
	/** Entries the scope binds: always `scope.artifactPaths.length`. */
	readonly selectedPathCount: number;
	/** Unique dirty entries no receipt can bind, such as a name carrying a backslash. */
	readonly excludedPathCount: number;
	/** True when the cap, not the filter, kept an eligible path out of the scope. */
	readonly truncated: boolean;
	readonly completeness: SessionScopeCompleteness;
	/** Digest of the sorted excluded set, so two different losses are distinguishable. Absent when nothing was excluded. */
	readonly excludedPathSetSha256?: string;
}

/**
 * Workspace scope for session bash receipts. Inside a git worktree the scope
 * root is the toplevel and `artifactPaths` is the current dirty set (staged,
 * modified, untracked; capped and sorted), which lets `captureWorkspaceFingerprint`
 * bind HEAD plus a scope-limited dirty digest. Outside git, falls back to an
 * empty artifact set under `cwd`. Never throws.
 */
export function resolveSessionWorkspaceScope(cwd: string, options?: { maxPaths?: number }): WorkspaceScope {
	return resolveSessionWorkspaceScopeReport(cwd, options).scope;
}

/**
 * The scope a receipt would bind, together with the completeness facts that say
 * whether binding it proves anything about the whole workspace.
 *
 * Cached per `(cwd, maxPaths)` for {@link SCOPE_TTL_MS}: keying the cap in too
 * keeps a capped probe from serving a later full request a truncated answer.
 */
export function resolveSessionWorkspaceScopeReport(
	cwd: string,
	options?: { maxPaths?: number },
): SessionWorkspaceScopeReport {
	const maxPaths = options?.maxPaths ?? SCOPE_MAX_PATHS;
	const key = `${maxPaths}\0${cwd}`;
	const cached = scopeCache.get(key);
	if (cached && Date.now() - cached.at < SCOPE_TTL_MS) return cached.report;
	const report = computeSessionWorkspaceScope(cwd, maxPaths);
	if (scopeCache.size >= SCOPE_CACHE_MAX) {
		const oldest = scopeCache.keys().next().value;
		if (oldest !== undefined) scopeCache.delete(oldest);
	}
	scopeCache.set(key, { at: Date.now(), report });
	return report;
}

/** Nothing was enumerated, so the empty artifact set proves nothing about the tree. */
function unavailableScope(root: string): SessionWorkspaceScopeReport {
	return {
		scope: { root, artifactPaths: [] },
		totalDirtyPathCount: 0,
		selectedPathCount: 0,
		excludedPathCount: 0,
		truncated: false,
		completeness: "unavailable",
	};
}

function computeSessionWorkspaceScope(cwd: string, maxPaths: number): SessionWorkspaceScopeReport {
	try {
		const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (top.status !== 0 || typeof top.stdout !== "string") return unavailableScope(cwd);
		const root = top.stdout.trim();
		if (root.length === 0) return unavailableScope(cwd);
		// File-granular untracked listing: -unormal emits untracked directories as
		// `dir/`, whose trailing slash fails assertNormalizedArtifactPath downstream
		// and kills every verified bash call in the session.
		const status = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 4 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (status.status !== 0 || !status.stdout) return unavailableScope(root);
		const fields = status.stdout.toString("utf8").split("\0");
		const paths = new Set<string>();
		const excluded = new Set<string>();
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
			if (isNormalizedArtifactPath(artifact)) paths.add(artifact);
			else excluded.add(artifact);
		}
		const eligible = [...paths].sort();
		const artifactPaths = eligible.slice(0, maxPaths);
		const truncated = artifactPaths.length < eligible.length;
		return {
			scope: { root, artifactPaths },
			totalDirtyPathCount: eligible.length + excluded.size,
			selectedPathCount: artifactPaths.length,
			excludedPathCount: excluded.size,
			truncated,
			// Truncation outranks exclusion: an excluded path is named by the digest
			// below, a capped one is an unbounded unknown.
			completeness: truncated ? "partial_truncated" : excluded.size > 0 ? "partial_excluded" : "complete",
			...(excluded.size === 0
				? {}
				: {
						excludedPathSetSha256: createHash("sha256")
							.update(`${EXCLUDED_SET_DOMAIN}${JSON.stringify([...excluded].sort())}`)
							.digest("hex"),
					}),
		};
	} catch {
		return unavailableScope(cwd);
	}
}
