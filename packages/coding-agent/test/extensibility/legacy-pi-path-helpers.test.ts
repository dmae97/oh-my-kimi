import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as shim from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

// Issue #5968: pi extensions import the SDK path helpers (`getAgentDir`,
// `getProjectDir`, `getPackageDir`) from `@earendil-works/pi-coding-agent`,
// which aliases to this shim. Only `getAgentDir` reached the surface via
// `export * from "../index"`; `getProjectDir` and `getPackageDir` were absent,
// so a named import of either threw Bun's static "Export named X not found"
// error and any importing extension failed validation. These pin the full
// path-helper surface through the public package specifier.
describe("legacy shim path helpers", () => {
	it("exports the three pi SDK path helpers as callable functions", () => {
		expect(typeof shim.getAgentDir).toBe("function");
		expect(typeof shim.getProjectDir).toBe("function");
		expect(typeof shim.getPackageDir).toBe("function");
	});

	it("getPackageDir resolves the coding-agent package root", () => {
		// omp's canonical helper returns the package root containing package.json
		// (pi's "install directory of the coding-agent package" semantics).
		const dir = shim.getPackageDir();
		expect(dir).toBeDefined();
		expect(path.basename(dir as string)).toBe("coding-agent");
	});
});
