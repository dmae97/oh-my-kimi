import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { hookFetch } from "@oh-my-pi/pi-utils";

/**
 * Regression test for #1449: a stalled Jina reader request must not prevent
 * local fallback renderers (trafilatura/lynx/native) from running within the
 * overall reader-mode budget.
 */
describe("renderHtmlToText: jina stall does not starve local fallbacks (#1449)", () => {
	afterEach(() => {
		// Nothing to restore — `using` handles fetch hook cleanup per-test.
	});

	it("falls back to native renderer when jina hangs until aborted", async () => {
		const settings = Settings.isolated({ "providers.parallelFetch": false });
		// Substantive HTML so the native converter produces >100 chars and
		// `isLowQualityOutput` does not reject it.
		const paragraphs = Array.from(
			{ length: 6 },
			(_, i) =>
				`<p>Paragraph number ${i + 1} carries some real content for the article body so the native renderer has enough text to satisfy the length threshold.</p>`,
		).join("");
		const html = `<!doctype html><html><head><title>Example</title></head><body><article><h1>Example article</h1>${paragraphs}</article></body></html>`;

		using _hook = hookFetch((input, _init, _next) => {
			const url = String(input);
			// Hang on the Jina reader endpoint until aborted, mirroring the
			// real bug: r.jina.ai stalls indefinitely.
			if (url.startsWith("https://r.jina.ai/")) {
				return new Promise<Response>((_resolve, reject) => {
					const signal = _init?.signal;
					if (!signal) return; // never settles
					if (signal.aborted) {
						reject(new DOMException("aborted", "AbortError"));
						return;
					}
					signal.addEventListener("abort", () => {
						reject(new DOMException("aborted", "AbortError"));
					});
				});
			}
			return new Response("", { status: 404 });
		});

		const started = Date.now();
		// `timeout: 2` keeps the overall budget tight — the test must complete
		// within ~2s even though Jina would otherwise hang for the full budget.
		const result = await renderHtmlToText("https://example.com/article", html, 2, settings, undefined, null);
		const elapsedMs = Date.now() - started;

		expect(result.ok).toBe(true);
		// Native converter is the only deterministic local fallback; trafilatura
		// and lynx may or may not be installed in CI, but native always works.
		// If trafilatura or lynx happened to succeed first, that's also a valid
		// non-aborted outcome.
		expect(["native", "trafilatura", "lynx"]).toContain(result.method);
		// Must finish well before the overall budget elapses: the remote
		// sub-budget caps Jina at min(timeout, REMOTE_READER_MAX_MS), so the
		// remaining ~1s of the 2s budget is enough for the native renderer.
		expect(elapsedMs).toBeLessThan(2_500);
	});

	it("re-throws when the user signal is aborted, not when Jina sub-budget expires", async () => {
		const settings = Settings.isolated({ "providers.parallelFetch": false });
		const html = "<html><body><p>short</p></body></html>";

		using _hook = hookFetch((_input, init, _next) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return; // Defensive: never settles otherwise.
				if (signal.aborted) {
					reject(new DOMException("aborted", "AbortError"));
					return;
				}
				signal.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		});

		const controller = new AbortController();
		const pending = renderHtmlToText(
			"https://example.com/article",
			html,
			30,
			settings,
			controller.signal,
			null,
		).catch(err => err);

		controller.abort();
		const outcome = await pending;
		expect(outcome).toBeInstanceOf(Error);
		expect(
			(outcome as Error).name === "AbortError" || (outcome as Error).message.toLowerCase().includes("abort"),
		).toBe(true);
	});
});
