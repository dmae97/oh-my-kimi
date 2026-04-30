/**
 * LSP-based linter client.
 * Uses the Language Server Protocol for formatting and diagnostics.
 */
import { getOrCreateClient, notifySaved, sendRequest, syncContent } from "../../lsp/client";
import { applyTextEditsToString } from "../../lsp/edits";
import type { Diagnostic, LinterClient, LspClient, ServerConfig, TextEdit } from "../../lsp/types";
import { fileToUri } from "../../lsp/utils";

/** Default formatting options for LSP */
const DEFAULT_FORMAT_OPTIONS = {
	tabSize: 3,
	insertSpaces: true,
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
};

/**
 * LSP-based linter client implementation.
 * Wraps the existing LSP client infrastructure.
 */
export class LspLinterClient implements LinterClient {
	#client: LspClient | null = null;

	/** Factory method for creating LspLinterClient instances */
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new LspLinterClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	async #getClient(): Promise<LspClient> {
		if (!this.#client) {
			this.#client = await getOrCreateClient(this.config, this.cwd);
		}
		return this.#client;
	}

	async format(filePath: string, content: string): Promise<string> {
		const client = await this.#getClient();
		const uri = fileToUri(filePath);

		// Sync content to LSP
		await syncContent(client, filePath, content);

		// Check if server supports formatting
		const caps = client.serverCapabilities;
		if (!caps?.documentFormattingProvider) {
			return content;
		}

		// Request formatting
		const edits = (await sendRequest(client, "textDocument/formatting", {
			textDocument: { uri },
			options: DEFAULT_FORMAT_OPTIONS,
		})) as TextEdit[] | null;

		if (!edits || edits.length === 0) {
			return content;
		}

		return applyTextEditsToString(content, edits);
	}

	async lint(filePath: string): Promise<Diagnostic[]> {
		const client = await this.#getClient();
		const uri = fileToUri(filePath);

		// Notify that file was saved to trigger diagnostics
		await notifySaved(client, filePath);

		// Wait for diagnostics with timeout
		const timeoutMs = 3000;
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const publishedDiagnostics = client.diagnostics.get(uri);
			if (publishedDiagnostics !== undefined) {
				return publishedDiagnostics.diagnostics;
			}
			await Bun.sleep(100);
		}

		return client.diagnostics.get(uri)?.diagnostics ?? [];
	}

	dispose(): void {
		// Client lifecycle is managed globally, nothing to dispose here
	}
}
