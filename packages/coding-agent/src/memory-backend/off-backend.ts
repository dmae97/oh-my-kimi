import type { MemoryBackend } from "./types";

/**
 * No-op memory backend.
 *
 * Selected when `memory.backend` is `"off"`.
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
