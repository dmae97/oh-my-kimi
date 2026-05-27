/**
 * Coding-agent runner that drives the hashline {@link Patcher} on behalf of
 * the `edit` tool. Converts a `{input, path?}` tool-call payload into a
 * fully-applied patch, wraps the result in the agent's
 * {@link AgentToolResult} shape, and attaches LSP diagnostics + `outputMeta`
 * for the renderer.
 *
 * Multi-section patches are preflighted up front via {@link Patcher.prepare}
 * so a partial batch never lands; the commit loop then narrows the LSP
 * batch's `flush` flag to true only for the final write so diagnostics
 * round-trip once.
 */
import {
	buildCompactDiffPreview,
	MismatchError as HashlineMismatchError,
	Patch,
	Patcher,
	type PatchSectionResult,
	type PreparedSection,
} from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { outputMeta } from "../../tools/output-meta";
import { generateDiffString } from "../diff";
import { getFileSnapshotStore } from "../file-snapshot-store";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "../renderer";
import { HashlineFilesystem } from "./filesystem";
import { type HashlineParams, hashlineEditParamsSchema } from "./params";

export interface ExecuteHashlineSingleOptions {
	session: ToolSession;
	input: string;
	path?: string;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

function getHashlineApplyOptions(session: ToolSession): { autoDropPureInsertDuplicates: boolean } {
	return {
		autoDropPureInsertDuplicates: session.settings.get("edit.hashlineAutoDropPureInsertDuplicates"),
	};
}

function noChangeDiagnostic(path: string): string {
	return `Edits to ${path} resulted in no changes being made.`;
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
	const seen = new Map<string, string>();
	for (const entry of prepared) {
		const previous = seen.get(entry.canonicalPath);
		if (previous !== undefined) {
			throw new Error(
				`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
			);
		}
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

function narrowBatchRequest(outer: LspBatchRequest | undefined, isLast: boolean): LspBatchRequest | undefined {
	if (!outer) return undefined;
	return { id: outer.id, flush: isLast && outer.flush };
}

interface RenderedSection {
	toolResult: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>;
	perFileResult: EditToolPerFileResult;
}

function renderSection(result: PatchSectionResult, diagnostics: FileDiagnosticsResult | undefined): RenderedSection {
	if (result.op === "noop") {
		const toolResult: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema> = {
			content: [{ type: "text", text: noChangeDiagnostic(result.path) }],
			details: { diff: "", op: "update", meta: outputMeta().get() },
		};
		return {
			toolResult,
			perFileResult: { path: result.path, diff: "", op: "update" },
		};
	}

	const diff = generateDiffString(result.before, result.after);
	const preview = buildCompactDiffPreview(diff.diff);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	const warningsBlock = result.warnings.length > 0 ? `\n\nWarnings:\n${result.warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n${preview.preview}` : "";
	const headline = preview.preview
		? `${result.path}:`
		: result.op === "create"
			? `Created ${result.path}`
			: `Updated ${result.path}`;

	const firstChangedLine = result.firstChangedLine ?? diff.firstChangedLine;
	return {
		toolResult: {
			content: [{ type: "text", text: `${headline}\n${result.header}${previewBlock}${warningsBlock}` }],
			details: {
				diff: diff.diff,
				firstChangedLine,
				diagnostics,
				op: result.op,
				meta,
			},
		},
		perFileResult: {
			path: result.path,
			diff: diff.diff,
			firstChangedLine,
			diagnostics,
			op: result.op,
		},
	};
}

export async function executeHashlineSingle(
	options: ExecuteHashlineSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const patch = Patch.parse(options.input, { cwd: options.session.cwd, path: options.path });
	if (patch.sections.length === 0) {
		throw new Error("No hashline sections found in input.");
	}

	const fs = new HashlineFilesystem({
		session: options.session,
		writethrough: options.writethrough,
		beginDeferredDiagnosticsForPath: options.beginDeferredDiagnosticsForPath,
		signal: options.signal,
		batchRequest: options.batchRequest,
	});
	const snapshots = getFileSnapshotStore(options.session);
	const applyOptions = getHashlineApplyOptions(options.session);
	const patcher = new Patcher({ fs, snapshots, applyOptions });

	// Single-section fast path: prepare, commit, render.
	if (patch.sections.length === 1) {
		fs.setBatchRequest(narrowBatchRequest(options.batchRequest, true));
		const prepared = await patcher.prepare(patch.sections[0]);
		const sectionResult = await patcher.commit(prepared);
		if (sectionResult.op === "noop") {
			return renderSection(sectionResult, undefined).toolResult;
		}
		return renderSection(sectionResult, fs.consumeDiagnostics(sectionResult.path)).toolResult;
	}

	// Multi-section: prepare every section up front so we fail fast before
	// any write hits the filesystem.
	const prepared: PreparedSection[] = [];
	for (const section of patch.sections) prepared.push(await patcher.prepare(section));
	assertUniqueCanonicalPaths(prepared);
	for (const entry of prepared) {
		if (entry.isNoop) throw new Error(noChangeDiagnostic(entry.section.path));
	}
	// Then commit each one, narrowing the LSP batch flush flag to the final
	// section only. A no-op apply mid-batch is treated as a hard failure —
	// the model authored anchors that match the current file content.
	const rendered: RenderedSection[] = [];
	for (let i = 0; i < prepared.length; i++) {
		const isLast = i === prepared.length - 1;
		fs.setBatchRequest(narrowBatchRequest(options.batchRequest, isLast));
		const sectionResult = await patcher.commit(prepared[i]);
		if (sectionResult.op === "noop") throw new Error(noChangeDiagnostic(sectionResult.path));
		rendered.push(renderSection(sectionResult, fs.consumeDiagnostics(sectionResult.path)));
	}

	return {
		content: [
			{
				type: "text",
				text: rendered
					.map(r => r.toolResult.content.map(part => (part.type === "text" ? part.text : "")).join("\n"))
					.join("\n\n"),
			},
		],
		details: {
			diff: rendered.map(r => r.toolResult.details?.diff ?? "").join("\n"),
			perFileResults: rendered.map(r => r.perFileResult),
		},
	};
}

export { HashlineMismatchError, type HashlineParams, hashlineEditParamsSchema };
