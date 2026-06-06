/**
 * Types for `omp gallery` sample data. See {@link ./index} for the aggregated
 * fixture registry and the contract each fixture must satisfy.
 */
import type { EditMode } from "../../edit";

/** A tool result snapshot, matching the shape `ToolExecutionComponent` consumes. */
export interface GalleryResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

export interface GalleryFixture {
	/** Display label for the tool header (defaults to the tool name). */
	label?: string;
	/** Edit mode for edit-like tools so the streaming preview dispatches correctly. */
	editMode?: EditMode;
	/**
	 * Arguments shown during the streaming state — a partial view of {@link args}
	 * as if the tool-call JSON were still arriving. May include `__partialJson`
	 * for renderers (bash, edit) that surface fields before the object closes.
	 * Defaults to {@link args} when omitted.
	 */
	streamingArgs?: unknown;
	/** Complete arguments shown for the in-progress, success, and error states. */
	args: unknown;
	/** Successful result. */
	result: GalleryResult;
	/** Failed result. Falls back to a generic error when omitted. */
	errorResult?: GalleryResult;
}
