/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs against the artifacts directories of every active
 * session. Parents and subagents share outputs via this registry: a subagent
 * can read its parent's output IDs because both sessions are registered in
 * the shared context.
 *
 * URL forms:
 * - agent://<id> - Full output content
 * - agent://<id>/<path> - JSON extraction via path form
 * - agent://<id>?q=<query> - JSON extraction via query form
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { applyQuery, pathToQuery } from "./json-query";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 * `SessionManager.getArtifactsDir()` is `sessionFile.slice(0, -6)`; we use
 * `sessionFile` directly here because handlers are read-only consumers.
 */
function artifactsDirsFromRegistry(): string[] {
	const dirs: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const file = ref.sessionFile;
		if (!file) continue;
		const dir = file.slice(0, -6);
		if (!dirs.includes(dir)) dirs.push(dir);
	}
	return dirs;
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

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}

		const urlPath = url.pathname;
		const queryParam = url.searchParams.get("q");
		const hasPathExtraction = urlPath && urlPath !== "/" && urlPath !== "";
		const hasQueryExtraction = queryParam !== null && queryParam !== "";

		if (hasPathExtraction && hasQueryExtraction) {
			throw new Error("agent:// URL cannot combine path extraction with ?q=");
		}

		const dirs = artifactsDirsFromRegistry();

		if (dirs.length === 0) {
			throw new Error("No session - agent outputs unavailable");
		}

		let foundPath: string | undefined;
		let anyDirExists = false;
		const availableIds = new Set<string>();

		for (const dir of dirs) {
			try {
				await fs.stat(dir);
				anyDirExists = true;
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			const candidate = path.join(dir, `${outputId}.md`);
			try {
				await fs.stat(candidate);
				foundPath = candidate;
				break;
			} catch (err) {
				if (!isEnoent(err)) throw err;
				try {
					const files = await fs.readdir(dir);
					for (const f of files) {
						if (f.endsWith(".md")) availableIds.add(f.replace(/\.md$/, ""));
					}
				} catch {
					// Listing failures are non-fatal; continue searching.
				}
			}
		}

		if (!anyDirExists) {
			throw new Error("No artifacts directory found");
		}

		if (!foundPath) {
			const availableStr = availableIds.size > 0 ? [...availableIds].join(", ") : "none";
			throw new Error(`Not found: ${outputId}\nAvailable: ${availableStr}`);
		}

		const rawContent = await Bun.file(foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";

		if (hasPathExtraction || hasQueryExtraction) {
			let jsonValue: unknown;
			try {
				jsonValue = JSON.parse(rawContent);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Output ${outputId} is not valid JSON: ${message}`);
			}

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
				content = JSON.stringify(jsonValue, null, 2);
			}
			contentType = "application/json";
		}

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: foundPath,
			notes,
		};
	}
}
