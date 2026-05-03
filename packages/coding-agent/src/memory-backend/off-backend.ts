import type { MemoryBackend } from "./types";

/**
 * No-op memory backend.
 *
 * Selected when `memory.backend` is `"off"`, or when `"local"` is selected but
 * `memories.enabled` is false (preserves the historical "memories disabled by
 * default" behaviour without forcing users to flip both switches).
 */
export const offBackend: MemoryBackend = {
	id: "off",
	async start() {},
	async buildDeveloperInstructions() {
		return undefined;
	},
	async clear() {},
	async enqueue() {},
};
