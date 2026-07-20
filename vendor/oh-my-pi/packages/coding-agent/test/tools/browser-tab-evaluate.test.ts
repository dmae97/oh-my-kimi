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

	it("clears request interception and held requests between runs, including thrown runs", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/held") return new Response("normal-held");
				if (pathname === "/mock") return new Response("normal-mock");
				return new Response("<title>Interception lifecycle</title>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const tool = new BrowserTool(makeSession());
		const name = `interception-lifecycle-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: `http://127.0.0.1:${server.port}/`,
			});
			let setupError: unknown;
			try {
				await tool.execute("run", {
					action: "run",
					name,
					code: `
						globalThis.__requestListenerBaseline = page.listenerCount("request");
						await page.setRequestInterception(true);
						page.on("request", request => void request.abort());
						throw new Error("setup failed");
					`,
				});
			} catch (error) {
				setupError = error;
			}
			expect(setupError).toBeInstanceOf(Error);
			expect(setupError).toHaveProperty("message", "setup failed");

			const afterThrow = await tool.execute("run", {
				action: "run",
				name,
				code: `
					return {
						clean: page.listenerCount("request") === globalThis.__requestListenerBaseline,
						body: await tab.evaluate(async () => await (await fetch("/mock")).text()),
					};
				`,
			});
			expect(afterThrow.content).toEqual([
				{ type: "text", text: '{\n  "clean": true,\n  "body": "normal-mock"\n}' },
			]);

			const intercepted = await tool.execute("run", {
				action: "run",
				name,
				code: `
					let heldSeen = false;
					await page.setRequestInterception(true);
					page.on("request", request => {
						const pathname = new URL(request.url()).pathname;
						if (pathname === "/held") {
							heldSeen = true;
							return;
						}
						if (pathname === "/mock") {
							void request.respond({ status: 200, body: "mocked" });
							return;
						}
						void request.continue();
					});
					await tab.evaluate(() => {
						globalThis.__heldFetch = fetch("/held").then(async response => await response.text());
					});
					await wait(() => heldSeen);
					return await tab.evaluate(async () => await (await fetch("/mock")).text());
				`,
			});
			expect(intercepted.content).toEqual([{ type: "text", text: "mocked" }]);

			const resumed = await tool.execute("run", {
				action: "run",
				name,
				code: `
					const listeners = page.listenerCount("request");
					if (listeners !== globalThis.__requestListenerBaseline) {
						return { clean: false, listeners, baseline: globalThis.__requestListenerBaseline };
					}
					return {
						clean: true,
						values: await tab.evaluate(async () => [
							await globalThis.__heldFetch,
							await (await fetch("/mock")).text(),
						]),
					};
				`,
			});
			expect(resumed.content).toEqual([
				{
					type: "text",
					text: '{\n  "clean": true,\n  "values": [\n    "normal-held",\n    "normal-mock"\n  ]\n}',
				},
			]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
			server.stop(true);
		}
	}, 30_000);

	it("fires a once request handler exactly once and clears it between runs", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/mock") return new Response("normal-mock");
				return new Response("<title>Once interception</title>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const tool = new BrowserTool(makeSession());
		const name = `once-interception-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: `http://127.0.0.1:${server.port}/`,
			});
			const fired = await tool.execute("run", {
				action: "run",
				name,
				code: `
					const baseline = page.listenerCount("request");
					globalThis.__requestListenerBaseline = baseline;
					await page.setRequestInterception(true);
					page.once("request", request => {
						if (new URL(request.url()).pathname === "/mock") {
							void request.respond({ status: 200, body: "mocked-once" });
							return;
						}
						void request.continue();
					});
					const body = await tab.evaluate(async () => await (await fetch("/mock")).text());
					// A once handler that fired must unregister from the emitter, not just the tracker.
					return { body, leaked: page.listenerCount("request") - baseline };
				`,
			});
			expect(fired.content).toEqual([{ type: "text", text: '{\n  "body": "mocked-once",\n  "leaked": 0\n}' }]);

			const resumed = await tool.execute("run", {
				action: "run",
				name,
				code: `
					return {
						clean: page.listenerCount("request") === globalThis.__requestListenerBaseline,
						body: await tab.evaluate(async () => await (await fetch("/mock")).text()),
					};
				`,
			});
			expect(resumed.content).toEqual([{ type: "text", text: '{\n  "clean": true,\n  "body": "normal-mock"\n}' }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
			server.stop(true);
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
