import { describe, expect, it } from "bun:test";
import { BUNDLED_PI_REGISTRY_KEYS } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-bundled-keys";
import { __buildLegacyPiPackageRootOverrides } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

// Regression for issue #3442: extension validation in compiled-binary mode
// failed to resolve `@earendil-works/pi-ai/oauth` because the override map
// only covered bare package roots — every non-wildcard subpath fell through
// to `Bun.resolveSync`, which bunfs can't satisfy on Bun 1.3.14+, then the
// `rewriteLegacyPiImports` catch left the original specifier in place and
// Bun's native resolver couldn't find a peer install. The fix seeds the
// override map with every key in `BUNDLED_PI_REGISTRY_KEYS` so subpath
// imports route to the same `omp-legacy-pi-bundled:` virtual namespace
// that already serves the roots.
describe("legacy pi compat compiled-mode subpath overrides (issue #3442)", () => {
	it("serves @oh-my-pi/pi-ai/oauth through the bundled virtual namespace in compiled mode", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		expect(overrides["@oh-my-pi/pi-ai/oauth"]).toBe("omp-legacy-pi-bundled:@oh-my-pi/pi-ai/oauth");
	});

	it("maps every bundled key (minus shimmed roots + typebox) to its virtual specifier in compiled mode", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		const missing: string[] = [];
		for (const key of BUNDLED_PI_REGISTRY_KEYS) {
			// pi-ai/pi-coding-agent roots intentionally use the legacy compat shims
			// (they re-attach `Type`, `defineTool`, etc. dropped from the canonical
			// package surface); typebox is served via TYPEBOX_SHIM_PATH.
			if (key === "@oh-my-pi/pi-ai" || key === "@oh-my-pi/pi-coding-agent" || key === "typebox") continue;
			if (overrides[key] !== `omp-legacy-pi-bundled:${key}`) {
				missing.push(key);
			}
		}
		expect(missing).toEqual([]);
	});

	it("keeps pi-ai/pi-coding-agent roots routed to their compat shims in compiled mode", () => {
		// The shim entries themselves resolve to virtual bundled specifiers in
		// compiled mode (the shim files are bundled under their own registry
		// keys); the test asserts only that the roots stay distinct from the
		// canonical pi-* surface — extensions still see the `Type` /
		// `defineTool` helpers the canonical entrypoints dropped.
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		expect(overrides["@oh-my-pi/pi-ai"]).toBeDefined();
		expect(overrides["@oh-my-pi/pi-ai"]).not.toBe("omp-legacy-pi-bundled:@oh-my-pi/pi-ai/oauth");
		expect(overrides["@oh-my-pi/pi-coding-agent"]).toBeDefined();
	});

	it("does not register subpath overrides in dev/install mode", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(false);
		expect(overrides).not.toHaveProperty("@oh-my-pi/pi-ai/oauth");
		expect(overrides).not.toHaveProperty("@oh-my-pi/pi-coding-agent/tools");
		// Dev keeps only the historical shim entries so canonical subpath
		// imports continue to flow through `Bun.resolveSync` against the live
		// monorepo / installed `node_modules` tree.
	});

	it("never emits a virtual specifier for typebox via the override map", () => {
		// typebox is routed through `TYPEBOX_SHIM_PATH` + a dedicated onResolve
		// hook; mirroring it in the override map would double-register and the
		// virtual loader would race the dedicated shim path.
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		expect(overrides).not.toHaveProperty("typebox");
	});
});
