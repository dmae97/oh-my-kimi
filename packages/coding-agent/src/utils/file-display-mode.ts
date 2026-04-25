/**
 * Resolve line-display mode for file-like outputs (read, grep, @file mentions).
 */

import { resolveEditMode } from "./edit-mode";

export interface FileDisplayMode {
	lineNumbers: boolean;
	hashLines: boolean;
	chunked: boolean;
}

/** Session-like object providing settings and tool availability for display mode resolution. */
export interface FileDisplayModeSession {
	/** Whether the edit tool is available. Hashlines are suppressed without it. */
	hasEditTool?: boolean;
	settings: {
		get(key: "readLineNumbers" | "readHashLines" | "edit.mode"): unknown;
	};
}

/**
 * Computes effective line display mode from session settings/env.
 * Hashline mode takes precedence and implies line-addressed output everywhere.
 * Hashlines are suppressed when the edit tool is not available (e.g. explore agents)
 * and when the caller signals a `raw` read — raw output should be returned as-is
 * without injecting hashline anchors or line numbers.
 */
export function resolveFileDisplayMode(
	session: FileDisplayModeSession,
	options?: { raw?: boolean },
): FileDisplayMode {
	const { settings } = session;
	const hasEditTool = session.hasEditTool ?? true;
	const editMode = resolveEditMode(session);
	const usesHashLineAnchors = editMode === "hashline" || editMode === "atom";
	const raw = options?.raw === true;
	const hashLines = !raw && hasEditTool && usesHashLineAnchors && settings.get("readHashLines") !== false;
	const chunked = !raw && hasEditTool && editMode === "chunk";
	return {
		hashLines,
		lineNumbers: !raw && (hashLines || settings.get("readLineNumbers") === true),
		chunked,
	};
}
