import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildBrowserNavigationHeaders } from "@oh-my-pi/pi-coding-agent/web/search/providers/browser-headers";

// The child process owns the mock, so this test never mutates a shared dependency.

const CHROME_FALLBACK_HEADERS: Record<string, string> = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "max-age=0",
	Priority: "u=0, i",
	"Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"macOS"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

const packageRoot = path.join(import.meta.dir, "../..");

describe("browser navigation headers", () => {
	it("returns the stable Mac Chrome profile when randomization is disabled", () => {
		expect(buildBrowserNavigationHeaders({ randomized: false })).toEqual(CHROME_FALLBACK_HEADERS);
	});

	it("imports cleanly and falls back when header-generator data files are absent", async () => {
		const script = [
			'import { mock } from "bun:test";',
			'mock.module("header-generator", () => ({ HeaderGenerator: class { constructor() { throw new Error("ENOENT: data_files/headers-order.json"); } } }));',
			"// Deliberate dynamic import: install the mock before loading the source under test.",
			'const { buildBrowserNavigationHeaders } = await import("@oh-my-pi/pi-coding-agent/web/search/providers/browser-headers");',
			"process.stdout.write(JSON.stringify(buildBrowserNavigationHeaders()));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual(CHROME_FALLBACK_HEADERS);
	});
});
