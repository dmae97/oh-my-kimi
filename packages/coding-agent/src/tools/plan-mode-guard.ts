import { resolveLocalUrlToPath, resolveVaultUrlToPath } from "../internal-urls";
import type { ToolSession } from ".";
import { normalizeLocalScheme, resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const VAULT_SCHEME_PREFIX = "vault:";
const LOCAL_SCHEME_PREFIX = "local:";

/** True when `targetPath` addresses the session-local artifact sandbox
 *  (`local://…`). Those files are not part of the working tree, so plan mode
 *  treats them as freely writable scratch/plan space. */
function targetsLocalSandbox(targetPath: string): boolean {
	return normalizeLocalScheme(targetPath).startsWith(LOCAL_SCHEME_PREFIX);
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

	if (targetsLocalSandbox(targetPath)) return;

	throw new ToolError(
		"Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md file instead.",
	);
}
