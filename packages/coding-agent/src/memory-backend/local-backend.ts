import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	enqueueMemoryConsolidation,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * No behavioural change — every call delegates to the legacy entry points so
 * the local memory pipeline (rollout summarisation → SQLite → memory_summary.md)
 * keeps working exactly as before.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings);
	},
	async clear(agentDir, cwd) {
		await clearMemoryData(agentDir, cwd);
	},
	async enqueue(agentDir, cwd) {
		enqueueMemoryConsolidation(agentDir, cwd);
	},
};
