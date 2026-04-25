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
 * Hashlines are suppressed when the edit tool is not available (e.g. explore agents).
 */
export function resolveFileDisplayMode(session: FileDisplayModeSession): FileDisplayMode {
	const { settings } = session;
	const hasEditTool = session.hasEditTool ?? true;
	const editMode = resolveEditMode(session);
	const usesHashLineAnchors = editMode === "hashline" || editMode === "atom";
	const hashLines = hasEditTool && usesHashLineAnchors && settings.get("readHashLines") !== false;
	const chunked = hasEditTool && resolveEditMode(session) === "chunk";
	return {
		hashLines,
		lineNumbers: hashLines || settings.get("readLineNumbers") === true,
		chunked,
	};
}
