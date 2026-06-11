import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("stats dashboard assets in distributed CLI builds", () => {
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const bundleScriptPath = path.join(repoRoot, "packages/coding-agent/scripts/bundle-dist.ts");
	const cliPath = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
	const statsServerPath = path.join(repoRoot, "packages/stats/src/server.ts");

	it("embeds the stats client archive while building the npm CLI bundle", async () => {
		const bundleScript = await Bun.file(bundleScriptPath).text();
		expect(bundleScript).toContain(`"scripts/generate-client-bundle.ts", "--generate"`);
		expect(bundleScript).toContain(`"scripts/generate-client-bundle.ts", "--reset"`);
		expect(bundleScript).toContain(`process.env.PI_BUNDLED="true"`);
	});

	it("uses embedded stats assets for prebuilt CLI distributions", async () => {
		const statsServer = await Bun.file(statsServerPath).text();
		expect(statsServer).toContain("process.env.PI_BUNDLED");
		expect(statsServer).toContain("USE_EMBEDDED_CLIENT");
		expect(statsServer).toContain("Embedded stats client bundle missing");
	});

	it("probes dashboard static assets in the install smoke test path", async () => {
		const cliSource = await Bun.file(cliPath).text();
		expect(cliSource).toContain("startServer(0)");
		expect(cliSource).toContain("127.0.0.1");
		expect(cliSource).toContain("dashboard HTML was not served");
	});
});
