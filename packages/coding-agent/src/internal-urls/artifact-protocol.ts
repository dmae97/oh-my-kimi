/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves artifact IDs against the artifacts directories of every active
 * session. Unlike agent://, artifacts are raw text with no JSON extraction.
 *
 * URL form:
 * - artifact://<id> - Full artifact content
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

/**
 * Snapshot of artifacts dirs across all registered sessions, deduped.
 *
 * Subagents adopt their parent's `ArtifactManager`, so their
 * `sessionManager.getArtifactsDir()` returns the parent's dir; dedup
 * collapses parent + N subagents to a single entry.
 */
function artifactsDirsFromRegistry(): string[] {
	const dirs: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const dir =
			ref.session?.sessionManager.getArtifactsDir() ?? (ref.sessionFile ? ref.sessionFile.slice(0, -6) : null);
		if (!dir) continue;
		if (!dirs.includes(dir)) dirs.push(dir);
	}
	return dirs;
}

export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const id = url.rawHost || url.hostname;
		if (!id) {
			throw new Error("artifact:// URL requires a numeric ID: artifact://0");
		}
		if (!/^\d+$/.test(id)) {
			throw new Error(`artifact:// ID must be numeric, got: ${id}`);
		}

		const dirs = artifactsDirsFromRegistry();

		if (dirs.length === 0) {
			throw new Error("No session - artifacts unavailable");
		}

		let foundPath: string | undefined;
		let anyDirExists = false;
		const availableIds = new Set<string>();

		for (const dir of dirs) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
				anyDirExists = true;
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			const match = files.find(f => f.startsWith(`${id}.`));
			if (match) {
				foundPath = path.join(dir, match);
				break;
			}
			for (const f of files) {
				const m = f.match(/^(\d+)\./);
				if (m) availableIds.add(m[1]);
			}
		}

		if (!anyDirExists) {
			throw new Error("No artifacts directory found");
		}

		if (!foundPath) {
			const sorted = [...availableIds].sort((a, b) => Number(a) - Number(b));
			const availableStr = sorted.length > 0 ? sorted.join(", ") : "none";
			throw new Error(`Artifact ${id} not found. Available: ${availableStr}`);
		}

		const content = await Bun.file(foundPath).text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: foundPath,
		};
	}
}
