import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Static } from "@sinclair/typebox";
import {
	createLspWritethrough,
	type FileDiagnosticsResult,
	type WritethroughCallback,
	type WritethroughDeferredHandle,
	writethroughNoop,
} from "../lsp";
import applyPatchDescription from "../prompts/tools/apply-patch.md" with { type: "text" };
import chunkEditDescription from "../prompts/tools/chunk-edit.md" with { type: "text" };
import hashlineDescription from "../prompts/tools/hashline.md" with { type: "text" };
import patchDescription from "../prompts/tools/patch.md" with { type: "text" };
import replaceDescription from "../prompts/tools/replace.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { VimTool, vimSchema } from "../tools/vim";
import { type EditMode, normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import type { VimToolDetails } from "../vim/types";
import {
	type ApplyPatchParams,
	applyPatchSchema,
	expandApplyPatchToEntries,
	isApplyPatchParams,
} from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import {
	type ChunkParams,
	type ChunkToolEdit,
	chunkEditParamsSchema,
	executeChunkSingle,
	isChunkParams,
	parseChunkEditPath,
	resolveAnchorStyle,
	resolveChunkAutoIndent,
} from "./modes/chunk";
import {
	executeHashlineSingle,
	type HashlineParams,
	type HashlineToolEdit,
	hashlineEditParamsSchema,
	isHashlineParams,
} from "./modes/hashline";
import {
	executePatchSingle,
	isPatchParams,
	type PatchEditEntry,
	type PatchParams,
	patchEditSchema,
} from "./modes/patch";
import {
	executeReplaceSingle,
	isReplaceParams,
	type ReplaceEditEntry,
	type ReplaceParams,
	replaceEditSchema,
} from "./modes/replace";
import { type EditToolDetails, type EditToolPerFileResult, getLspBatchRequest, type LspBatchRequest } from "./renderer";

export { DEFAULT_EDIT_MODE, type EditMode, normalizeEditMode } from "../utils/edit-mode";
export * from "./apply-patch";
export * from "./diff";
export * from "./line-hash";
export * from "./modes/apply-patch";
export * from "./modes/chunk";
export * from "./modes/hashline";
export * from "./modes/patch";
export * from "./modes/replace";
export * from "./normalize";
export * from "./renderer";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof chunkEditParamsSchema
	| typeof vimSchema
	| typeof applyPatchSchema;

type VimParams = Static<typeof vimSchema>;
type EditParams = ReplaceParams | PatchParams | HashlineParams | ChunkParams | VimParams | ApplyPatchParams;
type EditToolResultDetails = EditToolDetails | VimToolDetails;

type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	invalidParamsMessage: string;
	validate: (params: EditParams) => boolean;
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		batchRequest: LspBatchRequest | undefined,
		onUpdate?: (partialResult: AgentToolResult<EditToolResultDetails, TInput>) => void,
	) => Promise<AgentToolResult<EditToolResultDetails, TInput>>;
};

function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (!rawEditMode || rawEditMode === "auto") {
		return undefined;
	}

	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) {
		throw new Error(`Invalid PI_EDIT_VARIANT: ${rawEditMode}`);
	}

	return editMode;
}

function isVimParams(params: EditParams): params is VimParams {
	return typeof params === "object" && params !== null && "file" in params && typeof params.file === "string";
}

function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid PI_EDIT_FUZZY: ${rawValue}`);
	}
}

function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") {
		return session.settings.get("edit.fuzzyThreshold");
	}

	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid PI_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}

	return threshold;
}

function createEditWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = session.enableLsp ?? true;
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	return enableLsp ? createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics }) : writethroughNoop;
}

/** Group items by a key, preserving insertion order. */
function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
	const map = new Map<K, T[]>();
	for (const item of items) {
		const k = key(item);
		let arr = map.get(k);
		if (!arr) {
			arr = [];
			map.set(k, arr);
		}
		arr.push(item);
	}
	return map;
}

/** Run single-file executors for each file group and aggregate results. */
async function executePerFile(
	fileEntries: {
		path: string;
		run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails, any>>;
	}[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (fileEntries.length === 1) {
		// Single file — just run directly, no wrapping
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];

	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];
		const isLast = i === fileEntries.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await run(batchRequest);
			const details = result.details;
			perFileResults.push({
				path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				diagnostics: details?.diagnostics,
				op: details?.op,
				move: details?.move,
				meta: details?.meta,
			});
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			perFileResults.push({ path, diff: "", isError: true, errorText });
			contentTexts.push(`Error editing ${path}: ${errorText}`);
		}

		// Emit partial result after each file so UI shows progressive completion
		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: perFileResults
						.map(r => r.diff)
						.filter(Boolean)
						.join("\n"),
					firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
					perFileResults: [...perFileResults],
				},
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: {
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
			perFileResults,
		},
	};
}

export class EditTool implements AgentTool<TInput> {
	readonly name = "edit";
	readonly label = "Edit";
	readonly nonAbortable = true;
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode;
	readonly #vimTool: VimTool;
	readonly #pendingDeferredFetches = new Map<string, AbortController>();

	constructor(private readonly session: ToolSession) {
		const {
			PI_EDIT_FUZZY: editFuzzy = "auto",
			PI_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			PI_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;

		this.#editMode = resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		this.#writethrough = createEditWritethrough(session);
		this.#vimTool = new VimTool(session);
	}

	get mode(): EditMode {
		if (this.#editMode) return this.#editMode;
		return resolveEditMode(this.session);
	}

	get description(): string {
		return this.#getModeDefinition().description(this.session);
	}

	get parameters(): TInput {
		return this.#getModeDefinition().parameters;
	}

	/**
	 * When in `apply_patch` mode, expose the Codex Lark grammar so providers
	 * that support OpenAI-style custom tools can emit a grammar-constrained
	 * variant. Providers that don't support custom tools ignore this field
	 * and fall back to emitting a JSON function tool from `parameters`.
	 */
	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return { syntax: "lark", definition: applyPatchGrammar };
	}

	/**
	 * Wire-level tool name used when the custom-tool variant is active. GPT-5+
	 * is trained on the literal name `apply_patch`; internally this is just a
	 * mode of the `edit` tool. The agent-loop dispatcher matches both the
	 * internal `name` and `customWireName`, so returned calls route correctly.
	 */
	get customWireName(): string | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return "apply_patch";
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolResultDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolResultDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		if (!modeDefinition.validate(params)) {
			throw new Error(modeDefinition.invalidParamsMessage);
		}

		return modeDefinition.execute(this, params, signal, getLspBatchRequest(context?.toolCall), onUpdate);
	}

	#getModeDefinition(): EditModeDefinition {
		return {
			chunk: {
				description: (session: ToolSession) =>
					prompt.render(chunkEditDescription, {
						anchorStyle: resolveAnchorStyle(session.settings),
						chunkAutoIndent: resolveChunkAutoIndent(),
					}),
				parameters: chunkEditParamsSchema,
				invalidParamsMessage:
	"Invalid edit parameters for chunk mode. Expected `{ edits: [{ path: 'file:selector', ...op }, ...] }` with at least one edit. Each edit needs a `path`; supply one of `write` (string content; pass an empty string or omit it together with `replace`/`insert` to delete the chunk), `replace: { old, new }`, or `insert: { loc, body }`.",
				validate: isChunkParams,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits } = params as ChunkParams;
					const byFile = groupBy(edits, (e: ChunkToolEdit) => parseChunkEditPath(e.path).filePath);
					const entries = [...byFile.entries()].map(([filePath, fileEdits]) => ({
						path: filePath,
						run: (br: LspBatchRequest | undefined) =>
							executeChunkSingle({
								session: tool.session,
								path: filePath,
								edits: fileEdits,
								signal,
								batchRequest: br,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
							}),
					}));
					return executePerFile(entries, batchRequest, onUpdate);
				},
			},
			patch: {
				description: () => prompt.render(patchDescription),
				parameters: patchEditSchema,
				invalidParamsMessage: "Invalid edit parameters for patch mode.",
				validate: isPatchParams,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits } = params as PatchParams;
					const entries = edits.map((entry: PatchEditEntry) => ({
						path: entry.path,
						run: (br: LspBatchRequest | undefined) =>
							executePatchSingle({
								session: tool.session,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
							}),
					}));
					return executePerFile(entries, batchRequest, onUpdate);
				},
			},
			apply_patch: {
				description: () => prompt.render(applyPatchDescription),
				parameters: applyPatchSchema,
				invalidParamsMessage: "Invalid edit parameters for apply_patch mode.",
				validate: isApplyPatchParams,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
					const perFile = entries.map((entry: PatchEditEntry) => ({
						path: entry.path,
						run: (br: LspBatchRequest | undefined) =>
							executePatchSingle({
								session: tool.session,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
							}),
					}));
					return executePerFile(perFile, batchRequest, onUpdate);
				},
			},
			hashline: {
				description: () => prompt.render(hashlineDescription),
				parameters: hashlineEditParamsSchema,
				invalidParamsMessage: "Invalid edit parameters for hashline mode.",
				validate: isHashlineParams,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits } = params as HashlineParams;
					const byFile = groupBy(edits, (e: HashlineToolEdit) => e.path);
					const entries = [...byFile.entries()].map(([path, fileEdits]) => ({
						path,
						run: (br: LspBatchRequest | undefined) =>
							executeHashlineSingle({
								session: tool.session,
								path,
								edits: fileEdits,
								signal,
								batchRequest: br,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
							}),
					}));
					return executePerFile(entries, batchRequest, onUpdate);
				},
			},
			replace: {
				description: () => prompt.render(replaceDescription),
				parameters: replaceEditSchema,
				invalidParamsMessage: "Invalid edit parameters for replace mode.",
				validate: isReplaceParams,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits } = params as ReplaceParams;
					const entries = edits.map((entry: ReplaceEditEntry) => ({
						path: entry.path,
						run: (br: LspBatchRequest | undefined) =>
							executeReplaceSingle({
								session: tool.session,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
							}),
					}));
					return executePerFile(entries, batchRequest, onUpdate);
				},
			},
			vim: {
				description: () => this.#vimTool.description,
				parameters: vimSchema,
				invalidParamsMessage: "Invalid edit parameters for vim mode.",
				validate: isVimParams,
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					_batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolResultDetails, TInput>) => void,
				) => {
					const handleUpdate = onUpdate
						? (partialResult: AgentToolResult<VimToolDetails>) => {
								onUpdate(partialResult as AgentToolResult<EditToolResultDetails, TInput>);
							}
						: undefined;
					return (await tool.#vimTool.execute(
						"edit",
						params as VimParams,
						signal,
						handleUpdate,
					)) as AgentToolResult<EditToolResultDetails, TInput>;
				},
			},
		}[this.mode];
	}

	#beginDeferredDiagnosticsForPath(path: string): WritethroughDeferredHandle {
		const existingDeferred = this.#pendingDeferredFetches.get(path);
		if (existingDeferred) {
			existingDeferred.abort();
			this.#pendingDeferredFetches.delete(path);
		}

		const deferredController = new AbortController();
		return {
			onDeferredDiagnostics: (lateDiagnostics: FileDiagnosticsResult) => {
				this.#pendingDeferredFetches.delete(path);
				this.#injectLateDiagnostics(path, lateDiagnostics);
			},
			signal: deferredController.signal,
			finalize: (diagnostics: FileDiagnosticsResult | undefined) => {
				if (!diagnostics) {
					this.#pendingDeferredFetches.set(path, deferredController);
				} else {
					deferredController.abort();
				}
			},
		};
	}

	#injectLateDiagnostics(path: string, diagnostics: FileDiagnosticsResult): void {
		const summary = diagnostics.summary ?? "";
		const lines = diagnostics.messages ?? [];
		const body = [`Late LSP diagnostics for ${path} (arrived after the edit tool returned):`, summary, ...lines]
			.filter(Boolean)
			.join("\n");

		this.session.queueDeferredMessage?.({
			role: "custom",
			customType: "lsp-late-diagnostic",
			content: body,
			display: false,
			timestamp: Date.now(),
		});
	}
}
