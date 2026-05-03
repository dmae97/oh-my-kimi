import type { Settings } from "../config/settings";
import { hindsightBackend } from "../hindsight";
import { localBackend } from "./local-backend";
import { offBackend } from "./off-backend";
import type { MemoryBackend } from "./types";

/**
 * Pick the active memory backend for a Settings instance.
 *
 * Selection rules (single source of truth — every memory consumer routes
 * through this):
 *   - `memory.backend === "hindsight"`  → Hindsight remote memory
 *   - `memory.backend === "local"` and `memories.enabled === true` → local pipeline
 *   - everything else → no-op
 *
 * The legacy `memories.enabled` boolean still gates the local backend so users
 * who have it set to `false` keep getting silence, even after the new enum
 * defaults to `"local"`.
 */
export function resolveMemoryBackend(settings: Settings): MemoryBackend {
	const id = settings.get("memory.backend");
	if (id === "hindsight") return hindsightBackend;
	if (id === "local" && settings.get("memories.enabled")) return localBackend;
	return offBackend;
}
