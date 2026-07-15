import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { getTabsMapForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
}

/**
 * Whether the Chromium puppeteer resolves can actually execute on this host.
 * CI runners without Chrome's system libraries (libnspr4 & co.) hold the
 * downloaded binary but cannot exec it — probe with --version and skip
 * instead of failing.
 */
async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		const probe = Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" });
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

describe.skipIf(!CHROMIUM_AVAILABLE)("browser tab evaluation", () => {
	// Launches real headless Chromium; CI cold start easily exceeds bun's 5s default.
	it("runs tab.evaluate in the page's main JavaScript world", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `main-world-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<script>globalThis.__ompMainWorld = 42</script>",
			});
			const result = await tool.execute("run", {
				action: "run",
				name,
				code: "return await tab.evaluate(() => globalThis.__ompMainWorld);",
			});

			expect(result.content).toEqual([{ type: "text", text: "42" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("observes floating raw page promises when the target closes", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `target-close-${process.pid}`;
		const url = `data:text/html,<h1>ready</h1>#${name}`;

		try {
			await tool.execute("open", { action: "open", name, url });
			const tabSession = getTabsMapForTest().get(name);
			if (tabSession?.backend !== "worker") throw new Error("Worker tab was not created");
			const pages = await tabSession.browser.browser.pages();
			const targetPage = pages.find(page => page.url() === url);
			if (!targetPage) throw new Error(`Target page was not found for ${url}`);

			const started = targetPage.waitForFunction("document.documentElement.dataset.floating === 'true'", {
				polling: "mutation",
			});
			const run = tool.execute("run", {
				action: "run",
				name,
				code: "page.evaluate(() => { document.documentElement.dataset.floating = 'true'; return Promise.withResolvers().promise; }); try { await tab.waitForSelector('#never'); } catch {} return 'survived';",
			});
			const startedHandle = await started;
			await startedHandle.dispose();
			await targetPage.close();

			const result = await run;
			expect(result.content).toEqual([{ type: "text", text: "survived" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);
});
