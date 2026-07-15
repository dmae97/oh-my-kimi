/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered agent sessions.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";

const extraArtifactsDirs = new Set<string>();

export function registerArtifactsDir(dir: string): () => void {
	extraArtifactsDirs.add(dir);
	return () => {
		extraArtifactsDirs.delete(dir);
	};
}

export function resetRegisteredArtifactDirsForTests(): void {
	extraArtifactsDirs.clear();
}

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 *
 * Collects TWO candidate dirs per ref, because a subagent reads from its
 * adopted (root-wide) `ArtifactManager.dir` but its own children are written
 * one level deeper, under `sessionFile.slice(0, -6)` (`task/index.ts`). A
 * depth-2+ subagent's output therefore lives in the write-time dir, not the
 * adopted one, so `agent://` must scan both or it 404s a live nested peer.
 * `addDir` dedup collapses the depth-0 case (both formulas agree) back to a
 * single entry.
 */
export function artifactsDirsFromRegistry(): string[] {
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined) => {
		if (!dir) return;
		if (!dirs.includes(dir)) dirs.push(dir);
	};
	for (const ref of AgentRegistry.global().list()) {
		addDir(ref.session?.sessionManager?.getArtifactsDir());
		if (ref.sessionFile) addDir(ref.sessionFile.slice(0, -6));
	}
	for (const dir of extraArtifactsDirs) addDir(dir);
	return dirs;
}

/**
 * Recursively scan artifacts dirs for agent session transcripts, keyed by
 * agent id (the `.jsonl` basename). Used by `history://` so transcripts of
 * agents no longer in the registry (unregistered one-shot helpers, released
 * agents, or any agent after session resume) remain reachable — mirroring how
 * `agent://` reads `.md` outputs straight off disk.
 *
 * Layout follows `task/index.ts`: a subagent's transcript is
 * `<artifactsDir>/<AgentId>.jsonl`, and its own children nest one level deeper
 * under `<artifactsDir>/<AgentId>/<AgentId>.<ChildId>.jsonl`. Advisor
 * transcripts (`__advisor*.jsonl`) are observability-only and excluded;
 * EPERM-rewrite backups (`.bak`) are skipped. When the same id appears in
 * multiple dirs, the first hit wins (registry dirs are scanned first).
 */
export async function sessionFilesFromDisk(): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	const seenDirs = new Set<string>();
	const scan = async (dir: string, depth: number): Promise<void> => {
		if (depth > 8 || seenDirs.has(dir)) return;
		seenDirs.add(dir);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return;
			throw err;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await scan(path.join(dir, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const name = entry.name;
			if (!name.endsWith(".jsonl")) continue;
			if (name.startsWith("__advisor")) continue;
			const id = name.slice(0, -".jsonl".length);
			if (!found.has(id)) found.set(id, path.join(dir, name));
		}
	};
	for (const dir of artifactsDirsFromRegistry()) await scan(dir, 0);
	return found;
}
