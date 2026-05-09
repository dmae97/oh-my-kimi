import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { LspBatchRequest } from "../edit/renderer";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../lsp";
import type { ToolSession } from "../tools";

export interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

export type Anchor = {
	line: number;
	hash: string;
	contentHint?: string;
};

export type HashlineCursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before_anchor"; anchor: Anchor }
	| { kind: "after_anchor"; anchor: Anchor };

export type HashlineEdit =
	| { kind: "insert"; cursor: HashlineCursor; text: string; lineNum: number; index: number }
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string }
	| { kind: "modify"; anchor: Anchor; prefix: string; suffix: string; lineNum: number; index: number };

export const hashlineEditParamsSchema = Type.Object({ input: Type.String() });
export type HashlineParams = Static<typeof hashlineEditParamsSchema>;

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
