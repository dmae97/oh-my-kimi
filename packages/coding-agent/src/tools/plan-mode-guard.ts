import * as path from "node:path";
import { resolveLocalUrlToPath, resolveVaultUrlToPath } from "../internal-urls";
import type { ToolSession } from ".";
import { normalizeLocalScheme, resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const VAULT_SCHEME_PREFIX = "vault:";
const LOCAL_SCHEME_PREFIX = "local:";
const PLAN_ALIAS_FILE = "PLAN.md";
const LOCAL_PLAN_ALIAS = "local://PLAN.md";

function resolveRawPath(session: ToolSession, targetPath: string): string {
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

function isPlanAliasTarget(session: ToolSession, targetPath: string, resolved: string): boolean {
	const normalized = normalizeLocalScheme(targetPath);
	if (normalized === LOCAL_PLAN_ALIAS) return true;
	return resolved === resolveToCwd(PLAN_ALIAS_FILE, session.cwd);
}

/**
 * Resolve a write/edit target to its absolute filesystem path.
 *
 * In plan mode, transparently redirects `PLAN.md` aliases and targets whose
 * basename matches the plan file's basename to the canonical plan file
 * location at `state.planFilePath`. This lets `write` and `edit` accept the
 * habitual plan filename after approval even when the active artifact has a
 * titled path such as `local://APPROVED.md`.
 *
 * Outside plan mode (or when the basename does not match) this is a no-op.
 */
export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	const resolved = resolveRawPath(session, targetPath);

	const state = session.getPlanModeState?.();
	if (!state?.enabled) return resolved;

	const planResolved = resolveRawPath(session, state.planFilePath);
	if (resolved === planResolved) return resolved;
	if (isPlanAliasTarget(session, targetPath, resolved)) return planResolved;
	if (path.basename(resolved) !== path.basename(planResolved)) return resolved;

	return planResolved;
}

export function enforcePlanModeWrite(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	const resolvedTarget = resolvePlanPath(session, targetPath);
	const resolvedPlan = resolvePlanPath(session, state.planFilePath);

	if (options?.move) {
		throw new ToolError("Plan mode: renaming files is not allowed.");
	}

	if (options?.op === "delete") {
		throw new ToolError("Plan mode: deleting files is not allowed.");
	}

	if (resolvedTarget !== resolvedPlan) {
		throw new ToolError(`Plan mode: only the plan file may be modified (${state.planFilePath}).`);
	}
}
