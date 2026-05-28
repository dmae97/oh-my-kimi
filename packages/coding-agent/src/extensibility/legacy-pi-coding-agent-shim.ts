/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@oh-my-pi/pi-coding-agent` (or one of its aliased scopes like
 * `@earendil-works/pi-coding-agent` or `@mariozechner/pi-coding-agent`).
 *
 * The coding-agent package's own barrel (`./src/index.ts`) cannot be listed
 * as a `bun --compile` extra entrypoint alongside the CLI entry without
 * silently breaking the main binary's startup (see issue #1474 follow-up).
 * Routing legacy plugin imports through this sibling shim sidesteps that
 * conflict: bun bundles a distinct entry whose path differs from the CLI
 * entry, while still re-exporting the canonical surface so plugins observe
 * the same module identity as a direct `@oh-my-pi/pi-coding-agent` import.
 */

export * from "../index";
