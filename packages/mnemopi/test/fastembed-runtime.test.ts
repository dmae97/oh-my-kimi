import { describe, expect, test } from "bun:test";
import rootManifest from "../../../package.json" with { type: "json" };
import packageManifest from "../package.json" with { type: "json" };

// The fastembed/onnxruntime-node peers are pinned as exact versions (not
// `catalog:`) because `core/fastembed-runtime.ts` reads them to `bun install`
// the on-demand embedding runtime — including from bundles where the inlined
// manifest would otherwise carry an uninstallable `catalog:` spec (#2389).
// This pins the contract: the runtime install materializes exactly the
// versions the workspace develops and tests against.
describe("fastembed runtime version pins", () => {
	const catalog = rootManifest.workspaces.catalog;

	test("peer pins match the workspace catalog", () => {
		expect(packageManifest.peerDependencies.fastembed).toBe(catalog.fastembed);
		expect(packageManifest.peerDependencies["onnxruntime-node"]).toBe(catalog["onnxruntime-node"]);
	});

	test("pins are exact installable versions, not catalog or range specs", () => {
		expect(packageManifest.peerDependencies.fastembed).toMatch(/^\d+\.\d+\.\d+$/);
		expect(packageManifest.peerDependencies["onnxruntime-node"]).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
