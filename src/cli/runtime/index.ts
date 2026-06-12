/**
 * Phase 1 — CLI Runtime barrel export
 * Import from here, not from individual files.
 */

export * from "./types.js";
export * from "./cli-writer.js";
export * from "./event-bus.js";
export * from "./cli-runtime.js";
export * from "./run-controller.js";
export * from "./task-controller.js";
export * from "./plan-controller.js";

// Phase 1.5 — RuntimeSidecar + CapabilityPlan pipeline
export { classifyIntent, quickClassify } from "./intent-classifier.js";
export { selectCapabilities, createSubAgentCapabilityPlan } from "./capability-selector.js";
export { buildRuntimeSidecar, createSubAgentSidecar } from "./runtime-sidecar.js";
export {
  type SlashCommandHandler,
  type SlashCommandResult,
  registerSlashCommand,
  isSlashCommand,
  parseSlashCommand,
  dispatchSlashCommand,
  listSlashCommands,
} from "./command-bus.js";
export {
  registerProviderAdapter,
  getProviderAdapter,
  listProviderAdapters,
  hasProviderAdapter,
  selectProviderAdapter,
} from "./provider-adapter-registry.js";
export {
  createGenericProviderAdapter,
  createMockProviderAdapter,
} from "./generic-provider-adapter.js";
