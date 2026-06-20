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

	it("keeps puppeteer-core/@puppeteer/browsers off the eager startup graph", async () => {
		// The builtin tool registry (tools/index.ts) statically imports BrowserTool, which
		// reaches attach.ts -> registry.ts -> launch.ts -> tab-supervisor.ts. A *value*
		// import from puppeteer-core (e.g. the TargetType enum) executes puppeteer-core's
		// barrel at boot, which re-exports the node launchers + BrowserConnector and pulls in
		// @puppeteer/browsers (the Chromium downloader). A packaging quirk in that subtree then
		// becomes a hard startup crash (e.g. `Cannot find module './browser-data/browser-data.js'`)
		// instead of a recoverable ToolError on first browser use. These modules must therefore
		// import puppeteer packages as `import type` only. tab-worker.ts is excluded: it runs
		// solely inside the spawned browser worker, off the main startup graph.
		const browserDir = path.join(sourceRoot, "tools", "browser");
		const eagerFiles = ["attach.ts", "registry.ts", "launch.ts", "tab-supervisor.ts"];
		const valueImportRe = /^import\s+(?!type\b)[^;]*?from\s+["'](?:puppeteer-core|@puppeteer\/browsers)["']/gm;
		for (const file of eagerFiles) {
			const src = await Bun.file(path.join(browserDir, file)).text();
			const offenders = src.match(valueImportRe) ?? [];
			expect(offenders, `${file} value-imports puppeteer; use \`import type\``).toEqual([]);
		}
	});
});
