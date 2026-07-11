import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildBrowserNavigationHeaders } from "@oh-my-pi/pi-coding-agent/web/search/providers/browser-headers";
import { browserFetch } from "@oh-my-pi/pi-coding-agent/web/search/providers/browser-page";

afterEach(() => {
	vi.restoreAllMocks();
});

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
