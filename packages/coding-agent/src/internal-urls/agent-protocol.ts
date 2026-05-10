/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs to artifact files in the session directory.
 *
 * URL forms:
 * - agent://<id> - Full output content
 * - agent://<id>/<path> - JSON extraction via path form
 * - agent://<id>?q=<query> - JSON extraction via query form
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { applyQuery, pathToQuery } from "./json-query";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface AgentProtocolOptions {
	/**
	 * Returns the artifacts directory path, or null if no session.
	 * Artifacts directory is the session file path without .jsonl extension.
	 */
	getArtifactsDir: () => string | null;
}

/**
 * List available output IDs in artifacts directory.
 */
async function listAvailableOutputs(artifactsDir: string): Promise<string[]> {
	try {
		const files = await fs.readdir(artifactsDir);
		return files.filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""));
	} catch {
		return [];
	}
}

/**
 * Handler for agent:// URLs.
 *
 * Resolves output IDs like "reviewer_0" to their artifact files,
 * with optional JSON extraction.
 */
export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly immutable = true;

	constructor(private readonly options: AgentProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const artifactsDir = this.options.getArtifactsDir();
		if (!artifactsDir) {
			throw new Error("No session - agent outputs unavailable");
		}

		try {
			await fs.stat(artifactsDir);
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error("No artifacts directory found");
			}
			throw err;
		}

		// Extract output ID from host
		const outputId = url.rawHost || url.hostname;
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}

		// Check for conflicting extraction methods
		const urlPath = url.pathname;
		const queryParam = url.searchParams.get("q");
		const hasPathExtraction = urlPath && urlPath !== "/" && urlPath !== "";
		const hasQueryExtraction = queryParam !== null && queryParam !== "";

		if (hasPathExtraction && hasQueryExtraction) {
			throw new Error("agent:// URL cannot combine path extraction with ?q=");
		}

		// Load the output file
		const outputPath = path.join(artifactsDir, `${outputId}.md`);
		try {
			await fs.stat(outputPath);
		} catch (err) {
			if (isEnoent(err)) {
				const available = await listAvailableOutputs(artifactsDir);
				const availableStr = available.length > 0 ? available.join(", ") : "none";
				throw new Error(`Not found: ${outputId}\nAvailable: ${availableStr}`);
			}
			throw err;
		}

		const rawContent = await Bun.file(outputPath).text();
		const notes: string[] = [];

		// Handle extraction
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";

		if (hasPathExtraction || hasQueryExtraction) {
			// Parse JSON
			let jsonValue: unknown;
			try {
				jsonValue = JSON.parse(rawContent);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Output ${outputId} is not valid JSON: ${message}`);
			}

			// Convert path to query if needed
			const query = hasPathExtraction ? pathToQuery(urlPath) : queryParam!;

			if (query) {
				const extracted = applyQuery(jsonValue, query);
				try {
					content = JSON.stringify(extracted, null, 2) ?? "null";
				} catch {
					content = String(extracted);
				}
				notes.push(`Extracted: ${query}`);
			} else {
				// Empty path/query means return full JSON
				content = JSON.stringify(jsonValue, null, 2);
			}
			contentType = "application/json";
		}

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: outputPath,
			notes,
		};
	}
}
