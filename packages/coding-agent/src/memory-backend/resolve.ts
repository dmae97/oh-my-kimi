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
 *   - `memory.backend === "local"`      → local pipeline
 *   - everything else                   → no-op
 *
 * `memories.enabled` remains accepted only as a legacy migration input. Once
 * a config is loaded, `memory.backend` is the sole runtime selector.
 */
export function resolveMemoryBackend(settings: Settings): MemoryBackend {
	const id = settings.get("memory.backend");
	if (id === "hindsight") return hindsightBackend;
	if (id === "local") return localBackend;
	return offBackend;
}
