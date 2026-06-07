import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const sourceRoot = path.join(import.meta.dir, "..", "src");

describe("startup import graph", () => {
	it("keeps normal startup off the aggregate modes barrel", async () => {
		const mainSource = await Bun.file(path.join(sourceRoot, "main.ts")).text();

		expect(mainSource).toContain('import { InteractiveMode } from "./modes/interactive-mode";');
		expect(mainSource).not.toContain('from "./modes"');
	});

	it("keeps branch-only mode runners out of the modes barrel", async () => {
		const modesBarrelSource = await Bun.file(path.join(sourceRoot, "modes/index.ts")).text();

		expect(modesBarrelSource).toContain('from "./interactive-mode"');
		expect(modesBarrelSource).not.toContain("runAcpMode");
		expect(modesBarrelSource).not.toContain("runPrintMode");
		expect(modesBarrelSource).not.toContain("runRpcMode");
		expect(modesBarrelSource).not.toContain("./rpc/rpc-mode");
	});

	it("keeps marketplace implementation behind the lightweight auto-update starter", async () => {
		const mainSource = await Bun.file(path.join(sourceRoot, "main.ts")).text();
		const starterSource = await Bun.file(
			path.join(sourceRoot, "extensibility/plugins/marketplace-auto-update.ts"),
		).text();

		expect(mainSource).toContain('from "./extensibility/plugins/marketplace-auto-update"');
		expect(mainSource).not.toContain('from "./extensibility/plugins/marketplace"');
		expect(starterSource).toContain('await import("./marketplace")');
	});
});
