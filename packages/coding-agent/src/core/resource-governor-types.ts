/**
 * Resolved resource-governor settings shape.
 *
 * This interface lived in `resource-governor-settings.ts`, which re-exports the
 * formatter as the governor's single entry point, while the formatter imported
 * the interface back to describe what it renders — a two-module import cycle.
 * The facade is deliberate, so the shape moves down instead: both the settings
 * surface and the formatter now depend on this module, and neither depends on
 * the other.
 *
 * Types only. Imports stay limited to the admission layer, which sits below
 * both modules and imports neither.
 */

import type { ResourceAdmissionConfig, ResourceGovernorMode } from "./resource-admission.ts";

export interface ResolvedResourceGovernorSettings {
	readonly mode: ResourceGovernorMode;
	/** Only present when the setting is valid; the probe applies its own defaults otherwise. */
	readonly maxProbeMs?: number;
	readonly cpuSampleMs?: number;
	readonly admission: ResourceAdmissionConfig;
	/** §18.1 explicit validation errors; non-empty means defaults were applied for the failed area. */
	readonly errors: readonly string[];
}
