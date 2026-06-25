/**
 * Static handles on every bundled `@oh-my-pi/pi-*` surface a legacy extension
 * may import. Loaded lazily by `legacy-pi-compat.ts` in compiled-binary mode
 * (issue #3423) and re-exported through the `omp-legacy-pi-bundled:` virtual
 * namespace — bunfs paths cannot be resolved at runtime on Bun 1.3.14+, so
 * the only way to re-route extension imports onto the host's in-process copy
 * is via live module references captured at compile time.
 *
 * This module is split out from `legacy-pi-compat.ts` so dev/test runs that
 * touch the compat layer never trigger the cascade through
 * `legacy-pi-coding-agent-shim.ts → ../index → export/html/...` (which
 * requires generated artifacts that only exist after a `bun run build`).
 *
 * The bundler reaches every entry below via standard static-import analysis,
 * so the matching `--compile` extras can be dropped from
 * `scripts/build-binary.ts`.
 */
import * as bundledPiAgentCore from "@oh-my-pi/pi-agent-core";
import * as bundledPiNatives from "@oh-my-pi/pi-natives";
import * as bundledPiTui from "@oh-my-pi/pi-tui";
import * as bundledPiUtils from "@oh-my-pi/pi-utils";
import * as bundledLegacyPiAiShim from "../legacy-pi-ai-shim";
import * as bundledLegacyPiCodingAgentShim from "../legacy-pi-coding-agent-shim";
import * as bundledTypeBoxShim from "../typebox";

/**
 * Canonical specifier → live module namespace. Keys MUST match the right-hand
 * side of `bundledRegistryVirtualSpecifier(...)` calls in
 * `legacy-pi-compat.ts`; the synthesizer enumerates each namespace's own
 * enumerable exports at extension load time.
 */
export const BUNDLED_PI_REGISTRY: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
	"@oh-my-pi/pi-agent-core": bundledPiAgentCore,
	"@oh-my-pi/pi-ai": bundledLegacyPiAiShim,
	"@oh-my-pi/pi-coding-agent": bundledLegacyPiCodingAgentShim,
	"@oh-my-pi/pi-natives": bundledPiNatives,
	"@oh-my-pi/pi-tui": bundledPiTui,
	"@oh-my-pi/pi-utils": bundledPiUtils,
	typebox: bundledTypeBoxShim,
};
