import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserNavigationHeaders } from "@oh-my-pi/pi-coding-agent/web/search/providers/browser-headers";
import { browserFetch } from "@oh-my-pi/pi-coding-agent/web/search/providers/browser-page";

afterEach(() => {
	vi.restoreAllMocks();
});

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
	it("builds a randomized, internally consistent browser profile", () => {
		const headers = buildBrowserNavigationHeaders();

		// Ensure core navigation headers are always populated
		expect(headers["User-Agent"]).toBeDefined();
		expect(headers.Accept).toBeDefined();
		expect(headers["Accept-Language"]).toBeDefined();
		expect(headers["Accept-Encoding"]).toBeDefined();

		const ua = headers["User-Agent"] || "";

		// Ensure generated headers match standard conventions for the resolved browser type
		if (ua.includes("Firefox/")) {
			// Firefox doesn't support Client Hints and has unique accept values
			expect(headers["Sec-Ch-Ua"]).toBeUndefined();
			expect(headers["Sec-Ch-Ua-Platform"]).toBeUndefined();
			expect(headers.Accept).toContain("text/html");
		} else if (ua.includes("Chrome/")) {
			// Chrome, Edge, and Opera support Client Hints
			expect(headers["Sec-Ch-Ua"]).toBeDefined();
			expect(headers["Sec-Ch-Ua-Mobile"]).toBeDefined();
			expect(headers["Sec-Ch-Ua-Platform"]).toBeDefined();

			if (ua.includes("Edg/")) {
				expect(headers["Sec-Ch-Ua"]).toContain("Microsoft Edge");
			} else if (ua.includes("OPR/")) {
				expect(headers["Sec-Ch-Ua"]).toContain("Opera");
			} else {
				expect(headers["Sec-Ch-Ua"]).toContain("Google Chrome");
			}
		}
	});

	it("falls back gracefully to robust Mac Chrome profile when randomized option is disabled", () => {
		const headers = buildBrowserNavigationHeaders({ randomized: false });

		expect(headers["User-Agent"]).toContain("Chrome/149.0.0.0");
		expect(headers["User-Agent"]).toContain("Macintosh; Intel Mac OS X 10_15_7");
		expect(headers["Sec-Ch-Ua"]).toContain('v="149"');
		expect(headers["Sec-Ch-Ua-Platform"]).toBe('"macOS"');
	});

	it("returns stable fallback headers when header-generator data files are unavailable", async () => {
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

	it("uses ordinary fetch before considering the browser fallback", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("<html><body>results</body></html>", { status: 200 }));

		const page = await browserFetch("https://search.example/results", {
			signal: new AbortController().signal,
			browser: { shouldFallback: () => false },
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(page).toEqual({
			html: "<html><body>results</body></html>",
			status: 200,
			url: "https://search.example/results",
		});
	});
});
