import * as z from "zod/v4";
import type { LspBatchRequest } from "../edit/renderer";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../lsp";
import type { ToolSession } from "../tools";

export type Anchor = {
	line: number;
};

export type HashlineCursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before_anchor"; anchor: Anchor }
	| { kind: "after_anchor"; anchor: Anchor };

export type HashlineEdit =
	| { kind: "insert"; cursor: HashlineCursor; text: string; lineNum: number; index: number }
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string };

export interface HashlineInputSection {
	path: string;
	fileHash?: string;
	diff: string;
}

/** `path` is accepted by the edit tool runtime; other extra keys are preserved. */
export const hashlineEditParamsSchema = z.object({ input: z.string(), path: z.string().optional() }).passthrough();
export type HashlineParams = z.infer<typeof hashlineEditParamsSchema>;

export interface HashlineStreamOptions {
	/** First line number to use when formatting (1-indexed). */
	startLine?: number;
	/** Maximum formatted lines per yielded chunk (default: 200). */
	maxChunkLines?: number;
	/** Maximum UTF-8 bytes per yielded chunk (default: 64 KiB). */
	maxChunkBytes?: number;
}

export interface CompactHashlineDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

export interface CompactHashlineDiffOptions {
	/** Maximum entries kept on each side of an unchanged-context truncation (default: 2). */
	maxUnchangedRun?: number;
}
export interface HashlineApplyOptions {
	autoDropPureInsertDuplicates?: boolean;
}

export interface SplitHashlineOptions {
	cwd?: string;
	path?: string;
}

export interface ExecuteHashlineSingleOptions {
	session: ToolSession;
	input: string;
	path?: string;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}
