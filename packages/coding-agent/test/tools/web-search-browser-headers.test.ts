import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserNavigationHeaders } from "@oh-my-pi/pi-coding-agent/web/search/providers/browser-headers";

// The header-generator dependency reads its `data_files/*.json` via
// `readFileSync(`${__dirname}/data_files/...`)`. In a compiled single-file binary
// those assets resolve to the build-machine node_modules path, which is absent at
// runtime — the module used to construct HeaderGenerator eagerly and threw ENOENT
// at import time, poisoning the Bing provider import ("undefined is not a
// constructor") and the plugin extension loader (issue #5256). These tests guard
// the lazy-init + fallback contract so that regression cannot silently return.

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
const headerGeneratorRoot = path.dirname(fileURLToPath(import.meta.resolve("header-generator")));

describe("browser navigation headers", () => {
	it("returns the stable Mac Chrome profile when randomization is disabled", () => {
		const headers = buildBrowserNavigationHeaders({ randomized: false });

		expect(headers["User-Agent"]).toContain("Chrome/149.0.0.0");
		expect(headers["User-Agent"]).toContain("Macintosh; Intel Mac OS X 10_15_7");
		expect(headers["Sec-Ch-Ua"]).toContain('v="149"');
		expect(headers["Sec-Ch-Ua-Platform"]).toBe('"macOS"');
	});

	it("imports cleanly and falls back when header-generator data files are absent", async () => {
		// Simulate the compiled-binary condition: the fs-loaded data_files that
		// header-generator resolves at `${__dirname}/data_files` are missing at
		// runtime. A fresh subprocess ensures we exercise module import, not a
		// cached singleton from this test process.
		const dataFilesDir = path.join(headerGeneratorRoot, "data_files");
		const unavailableDataFilesDir = path.join(
			headerGeneratorRoot,
			`.data_files-unavailable-${process.pid}-${Date.now()}`,
		);

		await fs.rename(dataFilesDir, unavailableDataFilesDir);
		try {
			const script = [
				'import { buildBrowserNavigationHeaders } from "@oh-my-pi/pi-coding-agent/web/search/providers/browser-headers";',
				"const headers = buildBrowserNavigationHeaders();",
				"process.stdout.write(JSON.stringify(headers));",
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

			if (exitCode !== 0) {
				throw new Error(`browser header import failed with exit ${exitCode}:\n${stderr}`);
			}

			expect(JSON.parse(stdout)).toEqual(CHROME_FALLBACK_HEADERS);
		} finally {
			await fs.rename(unavailableDataFilesDir, dataFilesDir);
		}
	});
});
