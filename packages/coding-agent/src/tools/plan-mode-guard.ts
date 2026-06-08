import * as fs from "node:fs";
import * as path from "node:path";
import { resolveLocalRoot, resolveLocalUrlToPath, resolveVaultUrlToPath } from "../internal-urls";
import type { ToolSession } from ".";
import { normalizeLocalScheme, resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const VAULT_SCHEME_PREFIX = "vault:";
const LOCAL_SCHEME_PREFIX = "local:";

/** Resolve the absolute path of the session's `local://` artifact sandbox.
 *  Returns `null` when the session has no artifact wiring (e.g. tests). */
function localSandboxRoot(session: ToolSession): string | null {
	try {
		return path.resolve(
			resolveLocalRoot({
				getArtifactsDir: session.getArtifactsDir,
				getSessionId: session.getSessionId,
			}),
		);
	} catch {
		return null;
	}
}

/** True when `absolutePath` resolves inside `root` (== root or under it). */
function isWithinRoot(absolutePath: string, root: string): boolean {
	if (absolutePath === root) return true;
	const sep = `${root}${path.sep}`;
	return absolutePath.startsWith(sep);
}

/** True when `targetPath` addresses the session-local artifact sandbox.
 *  Accepts both `local://…` URLs and absolute paths pointing inside the
 *  resolved sandbox root — the latter is what `read local://…` echoes back
 *  in the `[path#tag]` header. Those files are not part of the working tree,
 *  so plan mode treats them as freely writable scratch/plan space. */
function targetsLocalSandbox(session: ToolSession, targetPath: string): boolean {
	const normalized = normalizeLocalScheme(targetPath);
	if (normalized.startsWith(LOCAL_SCHEME_PREFIX)) return true;
	if (!path.isAbsolute(normalized)) return false;
	const root = localSandboxRoot(session);
	if (!root) return false;
	// Compare both raw and realpath-normalized forms so that
	// `/tmp/…` vs `/private/tmp/…` (macOS) and other symlink-collapsed
	// roots both resolve to the same sandbox identity.
	const resolved = path.resolve(normalized);
	if (isWithinRoot(resolved, root)) return true;
	try {
		const realRoot = fs.realpathSync.native(root);
		if (isWithinRoot(resolved, realRoot)) return true;
		// `resolved` itself may live in `/tmp/...` while `realRoot` is `/private/tmp/...`;
		// realpath the parent dir of `resolved` so we catch that direction too.
		const realParent = fs.realpathSync.native(path.dirname(resolved));
		return isWithinRoot(path.join(realParent, path.basename(resolved)), realRoot);
	} catch {
		return false;
	}
}

/**
 * Resolve a write/edit target to its absolute filesystem path, honoring the
 * `local://` and `vault://` schemes. Plain paths resolve against the session cwd.
 */
export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	const normalized = normalizeLocalScheme(targetPath);
	if (normalized.startsWith(LOCAL_SCHEME_PREFIX)) {
		return resolveLocalUrlToPath(normalized, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
	}

	if (normalized.startsWith(VAULT_SCHEME_PREFIX)) {
		return resolveVaultUrlToPath(normalized);
	}

	return resolveToCwd(normalized, session.cwd);
}

/**
 * Plan mode keeps the working tree read-only while letting the agent draft its
 * plan. Writes and edits to the `local://` artifact sandbox are allowed (that is
 * where the plan and any scratch notes live); anything that would touch the
 * working tree — or rename/delete a file — is rejected.
 */
export function enforcePlanModeWrite(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	if (options?.move) {
		throw new ToolError("Plan mode: renaming files is not allowed.");
	}

	if (options?.op === "delete") {
		throw new ToolError("Plan mode: deleting files is not allowed.");
	}

	if (targetsLocalSandbox(session, targetPath)) return;

	throw new ToolError(
		"Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md file instead.",
	);
}
