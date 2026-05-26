import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { generateDiffString } from "../edit/diff";
import { getFileReadCache } from "../edit/file-read-cache";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../edit/normalize";
import { readEditFileText, serializeEditFileText } from "../edit/read-file";
import type { EditToolDetails } from "../edit/renderer";
import type { ToolSession } from "../tools";
import { assertEditableFileContent } from "../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../tools/fs-cache-invalidation";
import { outputMeta } from "../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../tools/plan-mode-guard";
import { HashlineMismatchError } from "./anchors";
import { applyHashlineEdits, type HashlineApplyResult } from "./apply";
import { buildCompactHashlineDiffPreview } from "./diff-preview";
import { parseHashline } from "./executor";
import { computeFileHash } from "./hash";
import { splitHashlineInputs } from "./input";
import { tryRecoverHashlineWithCache } from "./recovery";
import type {
	ExecuteHashlineSingleOptions,
	HashlineApplyOptions,
	HashlineEdit,
	HashlineInputSection,
	hashlineEditParamsSchema,
} from "./types";

interface ReadHashlineFileResult {
	exists: boolean;
	rawContent: string;
}

async function readHashlineFile(absolutePath: string, pathText: string): Promise<ReadHashlineFileResult> {
	try {
		return { exists: true, rawContent: await readEditFileText(absolutePath, pathText) };
	} catch (error) {
		if (isEnoent(error)) return { exists: false, rawContent: "" };
		if (error instanceof Error && error.message === `File not found: ${pathText}`)
			return { exists: false, rawContent: "" };
		throw error;
	}
}

function hasAnchorScopedEdit(edits: HashlineEdit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function collectAnchorLines(edits: HashlineEdit[]): number[] {
	const lines = new Set<number>();
	for (const edit of edits) {
		if (edit.kind === "delete") {
			lines.add(edit.anchor.line);
			continue;
		}
		if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") {
			lines.add(edit.cursor.anchor.line);
		}
	}
	return [...lines].sort((a, b) => a - b);
}

function assertSectionHashAllowed(sectionPath: string, fileHash: string | undefined, edits: HashlineEdit[]): void {
	if (fileHash !== undefined || !hasAnchorScopedEdit(edits)) return;
	throw new Error(
		`Missing hashline file hash for anchored edit to ${sectionPath}; use \`¶${sectionPath}#hash\` from your latest read.`,
	);
}

function formatNoChangeDiagnostic(pathText: string): string {
	return `Edits to ${pathText} resulted in no changes being made.`;
}

function getHashlineApplyOptions(session: ToolSession): HashlineApplyOptions {
	return {
		autoDropPureInsertDuplicates: session.settings.get("edit.hashlineAutoDropPureInsertDuplicates"),
	};
}

function getTextContent(result: AgentToolResult<EditToolDetails>): string {
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

function getEditDetails(result: AgentToolResult<EditToolDetails>): EditToolDetails {
	return result.details ?? { diff: "" };
}

/**
 * Apply hashline edits with file-hash stale recovery. The section hash gates
 * line-number edits against the version shown to the model; if the live file
 * drifted, snapshot recovery attempts a strict 3-way merge.
 */
function applyHashlineEditsWithRecovery(
	session: ToolSession,
	absolutePath: string,
	pathText: string,
	text: string,
	fileHash: string | undefined,
	edits: HashlineEdit[],
	options: HashlineApplyOptions,
): HashlineApplyResult {
	if (fileHash === undefined) return applyHashlineEdits(text, edits, options);

	const currentHash = computeFileHash(text);
	if (currentHash === fileHash) return applyHashlineEdits(text, edits, options);

	const cache = getFileReadCache(session);
	const recovered = tryRecoverHashlineWithCache({
		cache,
		absolutePath,
		currentText: text,
		fileHash,
		edits,
		options,
	});
	if (recovered) {
		return {
			lines: recovered.lines,
			firstChangedLine: recovered.firstChangedLine,
			warnings: recovered.warnings,
		};
	}

	throw new HashlineMismatchError({
		path: pathText,
		expectedFileHash: fileHash,
		actualFileHash: currentHash,
		fileLines: text.split("\n"),
		anchorLines: collectAnchorLines(edits),
	});
}

/**
 * Run all the front-end checks (notebook guard, parse, plan-mode check, file
 * load, edit application) without writing. Used to fail fast before applying
 * any changes in a multi-section batch.
 */
async function preflightHashlineSection(options: ExecuteHashlineSingleOptions & HashlineInputSection): Promise<void> {
	const { session, path: sectionPath, fileHash, diff } = options;

	const absolutePath = resolvePlanPath(session, sectionPath);
	const { edits } = parseHashline(diff);
	assertSectionHashAllowed(sectionPath, fileHash, edits);
	enforcePlanModeWrite(session, sectionPath, { op: "update" });

	const source = await readHashlineFile(absolutePath, sectionPath);
	if (!source.exists && hasAnchorScopedEdit(edits)) throw new Error(`File not found: ${sectionPath}`);
	if (source.exists) assertEditableFileContent(source.rawContent, sectionPath);

	const { text } = stripBom(source.rawContent);
	const normalized = normalizeToLF(text);
	const result = applyHashlineEditsWithRecovery(
		session,
		absolutePath,
		sectionPath,
		normalized,
		source.exists ? fileHash : undefined,
		edits,
		getHashlineApplyOptions(session),
	);
	if (normalized === result.lines) throw new Error(formatNoChangeDiagnostic(sectionPath));
}

async function executeHashlineSection(
	options: ExecuteHashlineSingleOptions & HashlineInputSection,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const {
		session,
		path: sourcePath,
		fileHash,
		diff,
		signal,
		batchRequest,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;

	const absolutePath = resolvePlanPath(session, sourcePath);
	const { edits, warnings: parseWarnings } = parseHashline(diff);
	assertSectionHashAllowed(sourcePath, fileHash, edits);
	enforcePlanModeWrite(session, sourcePath, { op: "update" });

	const source = await readHashlineFile(absolutePath, sourcePath);
	if (!source.exists && hasAnchorScopedEdit(edits)) throw new Error(`File not found: ${sourcePath}`);
	if (source.exists) assertEditableFileContent(source.rawContent, sourcePath);

	const { bom, text } = stripBom(source.rawContent);
	const originalEnding = detectLineEnding(text);
	const originalNormalized = normalizeToLF(text);
	const result = applyHashlineEditsWithRecovery(
		session,
		absolutePath,
		sourcePath,
		originalNormalized,
		source.exists ? fileHash : undefined,
		edits,
		getHashlineApplyOptions(session),
	);

	if (originalNormalized === result.lines) {
		return {
			content: [{ type: "text", text: formatNoChangeDiagnostic(sourcePath) }],
			details: { diff: "", op: "update", meta: outputMeta().get() },
		};
	}

	const finalContent = await serializeEditFileText(
		absolutePath,
		sourcePath,
		bom + restoreLineEndings(result.lines, originalEnding),
	);
	const diagnostics = await writethrough(
		absolutePath,
		finalContent,
		signal,
		Bun.file(absolutePath),
		batchRequest,
		dst => (dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined),
	);
	invalidateFsScanAfterWrite(absolutePath);
	// The post-edit content is the freshest, most authoritative "model view"
	// of the file: the model just received it back as the diff/preview. Cache
	// it so a follow-up edit anchored against this state can still recover
	// if the file is touched out-of-band before the next edit lands.
	getFileReadCache(session).recordContiguous(absolutePath, 1, result.lines.split("\n"), {
		fullText: result.lines,
		fileHash: computeFileHash(result.lines),
	});

	const diffResult = generateDiffString(originalNormalized, result.lines);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();
	const preview = buildCompactHashlineDiffPreview(diffResult.diff);

	const warnings = [...parseWarnings, ...(result.warnings ?? [])];
	const warningsBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n${preview.preview}` : "";
	const headline = preview.preview
		? `${sourcePath}:`
		: source.exists
			? `Updated ${sourcePath}`
			: `Created ${sourcePath}`;

	return {
		content: [{ type: "text", text: `${headline}${previewBlock}${warningsBlock}` }],
		details: {
			diff: diffResult.diff,
			firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine,
			diagnostics,
			op: source.exists ? "update" : "create",
			meta,
		},
	};
}

export async function executeHashlineSingle(
	options: ExecuteHashlineSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const sections = mergeSamePathSections(
		splitHashlineInputs(options.input, { cwd: options.session.cwd, path: options.path }),
	);

	// Fast path: a single section needs no preflight pass.
	if (sections.length === 1) return executeHashlineSection({ ...options, ...sections[0] });

	// Multi-section: validate everything up front so we don't apply a partial batch.
	for (const section of sections) await preflightHashlineSection({ ...options, ...section });

	const results = [];
	for (const section of sections) {
		results.push({ path: section.path, result: await executeHashlineSection({ ...options, ...section }) });
	}

	return {
		content: [{ type: "text", text: results.map(({ result }) => getTextContent(result)).join("\n\n") }],
		details: {
			diff: results.map(({ result }) => getEditDetails(result).diff).join("\n"),
			perFileResults: results.map(({ path: resultPath, result }) => {
				const details = getEditDetails(result);
				return {
					path: resultPath,
					diff: details.diff,
					firstChangedLine: details.firstChangedLine,
					diagnostics: details.diagnostics,
					op: details.op,
					move: details.move,
					meta: details.meta,
				};
			}),
		},
	};
}

/**
 * Collapse consecutive or interleaved sections targeting the same path into a
 * single section with concatenated diffs. Anchors authored against the same
 * file snapshot must be applied as one batch; otherwise the first sub-edit
 * shifts line numbers out from under the second's anchors and validation fails.
 * Path order is preserved by first occurrence.
 */
function mergeSamePathSections(sections: HashlineInputSection[]): HashlineInputSection[] {
	const byPath = new Map<string, { fileHash?: string; diffs: string[] }>();
	for (const section of sections) {
		const existing = byPath.get(section.path);
		if (existing) {
			if (
				existing.fileHash !== undefined &&
				section.fileHash !== undefined &&
				existing.fileHash !== section.fileHash
			) {
				throw new Error(
					`Conflicting hashline file hashes for ${section.path}: #${existing.fileHash} and #${section.fileHash}. Re-read the file and retry with one current header.`,
				);
			}
			if (existing.fileHash === undefined && section.fileHash !== undefined) existing.fileHash = section.fileHash;
			existing.diffs.push(section.diff);
			continue;
		}
		byPath.set(section.path, {
			...(section.fileHash !== undefined ? { fileHash: section.fileHash } : {}),
			diffs: [section.diff],
		});
	}
	return Array.from(byPath, ([path, entry]) => ({
		path,
		...(entry.fileHash !== undefined ? { fileHash: entry.fileHash } : {}),
		diff: entry.diffs.join("\n"),
	}));
}
