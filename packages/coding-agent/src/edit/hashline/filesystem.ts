/**
 * Coding-agent specific {@link Filesystem} adapter for the hashline patcher.
 *
 * Wires hashline's storage abstraction to the agent runtime:
 *
 * - Section paths are resolved through the plan-mode redirect so a bare
 *   `PLAN.md` lands at the canonical session artifact location.
 * - Reads go through `readEditFileText` (notebook-aware) and the
 *   auto-generated-file guard.
 * - Writes go through `serializeEditFileText` (notebook-aware) and the
 *   LSP writethrough, with FS-scan cache invalidation on success. The
 *   resulting `FileDiagnosticsResult` is captured per-path so the
 *   orchestrator can attach it to the tool result.
 *
 * Construct one per `executeHashlineSingle` call: per-section state
 * (batch request, diagnostics) lives on the instance and isn't safe to
 * share across concurrent edit tools.
 */
import { Filesystem, NotFoundError, type WriteResult } from "@oh-my-pi/hashline";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { readEditFileText, serializeEditFileText } from "../read-file";
import type { LspBatchRequest } from "../renderer";

export interface HashlineFilesystemOptions {
	session: ToolSession;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	signal?: AbortSignal;
	/**
	 * Outer LSP batch request inherited from the tool-call context. The
	 * orchestrator narrows this per-section (flush only on the final write)
	 * via {@link HashlineFilesystem.setBatchRequest}.
	 */
	batchRequest?: LspBatchRequest;
}

export class HashlineFilesystem extends Filesystem {
	readonly session: ToolSession;
	readonly #writethrough: WritethroughCallback;
	readonly #beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	readonly #signal: AbortSignal | undefined;
	#batchRequest: LspBatchRequest | undefined;
	#diagnosticsByPath = new Map<string, FileDiagnosticsResult | undefined>();

	constructor(options: HashlineFilesystemOptions) {
		super();
		this.session = options.session;
		this.#writethrough = options.writethrough;
		this.#beginDeferredDiagnosticsForPath = options.beginDeferredDiagnosticsForPath;
		this.#signal = options.signal;
		this.#batchRequest = options.batchRequest;
	}

	/**
	 * Set the LSP batch request used for the next {@link writeText} call.
	 * Multi-section orchestrators flip the `flush` flag to true before the
	 * final section so LSP diagnostics flush in one round-trip.
	 */
	setBatchRequest(batchRequest: LspBatchRequest | undefined): void {
		this.#batchRequest = batchRequest;
	}

	/**
	 * Look up (and clear) the diagnostics captured by the most-recent
	 * {@link writeText} call for `path`. Returns `undefined` if no write
	 * has happened or the writethrough returned no diagnostics.
	 */
	consumeDiagnostics(path: string): FileDiagnosticsResult | undefined {
		const value = this.#diagnosticsByPath.get(path);
		this.#diagnosticsByPath.delete(path);
		return value;
	}

	resolveAbsolute(relativePath: string): string {
		return resolvePlanPath(this.session, relativePath);
	}

	canonicalPath(relativePath: string): string {
		return this.resolveAbsolute(relativePath);
	}

	async readText(relativePath: string): Promise<string> {
		const absolutePath = this.resolveAbsolute(relativePath);
		let content: string;
		try {
			content = await readEditFileText(absolutePath, relativePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			if (error instanceof Error && error.message === `File not found: ${relativePath}`) {
				throw new NotFoundError(relativePath, error);
			}
			throw error;
		}
		// Refuse edits against generated files (lockfiles, models.json, …).
		assertEditableFileContent(content, relativePath);
		return content;
	}

	async preflightWrite(relativePath: string): Promise<void> {
		enforcePlanModeWrite(this.session, relativePath, { op: "update" });
	}

	async writeText(relativePath: string, content: string): Promise<WriteResult> {
		await this.preflightWrite(relativePath);
		const absolutePath = this.resolveAbsolute(relativePath);
		const finalContent = await serializeEditFileText(absolutePath, relativePath, content);
		const diagnostics = await this.#writethrough(
			absolutePath,
			finalContent,
			this.#signal,
			Bun.file(absolutePath),
			this.#batchRequest,
			dst => (dst === absolutePath ? this.#beginDeferredDiagnosticsForPath(absolutePath) : undefined),
		);
		invalidateFsScanAfterWrite(absolutePath);
		this.#diagnosticsByPath.set(relativePath, diagnostics);
		return { text: finalContent };
	}

	async exists(relativePath: string): Promise<boolean> {
		const absolutePath = this.resolveAbsolute(relativePath);
		return Bun.file(absolutePath).exists();
	}
}
