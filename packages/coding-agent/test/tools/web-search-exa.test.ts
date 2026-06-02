import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { hookFetch } from "@oh-my-pi/pi-utils";
import {
	buildExaRequestBody,
	ExaProvider,
	normalizeSearchType,
	searchExa,
	synthesizeAnswer,
} from "../../src/web/search/providers/exa";

async function withLocalAuthStorage<T>(run: (authStorage: AuthStorage) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-exa-auth-"));
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	try {
		return await run(authStorage);
	} finally {
		authStorage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

// ────────────────────────────────────────────────────────────
// Unit tests for pure helpers (no mocking needed)
// ────────────────────────────────────────────────────────────

describe("normalizeSearchType", () => {
	it("returns 'auto' for undefined input", () => {
		expect(normalizeSearchType(undefined)).toBe("auto");
	});

	it("maps 'keyword' to 'fast'", () => {
		expect(normalizeSearchType("keyword")).toBe("fast");
	});

	it("passes through 'neural' unchanged", () => {
		expect(normalizeSearchType("neural")).toBe("neural");
	});

	it("passes through 'deep' unchanged", () => {
		expect(normalizeSearchType("deep")).toBe("deep");
	});

	it("passes through 'auto' unchanged", () => {
		expect(normalizeSearchType("auto")).toBe("auto");
	});

	it("passes through 'fast' unchanged", () => {
		expect(normalizeSearchType("fast")).toBe("fast");
	});
});

describe("buildExaRequestBody", () => {
	it("builds correct minimal body with defaults", () => {
		const body = buildExaRequestBody({ query: "test query" });
		expect(body).toEqual({
			query: "test query",
			numResults: 10,
			type: "auto",
			contents: { summary: { query: "test query" } },
		});
	});

	it("applies num_results override", () => {
		const body = buildExaRequestBody({ query: "q", num_results: 5 });
		expect(body.numResults).toBe(5);
	});

	it("normalizes keyword type to fast", () => {
		const body = buildExaRequestBody({ query: "q", type: "keyword" });
		expect(body.type).toBe("fast");
	});

	it("includes domain filters when specified", () => {
		const body = buildExaRequestBody({
			query: "q",
			include_domains: ["example.com"],
			exclude_domains: ["bad.com"],
		});
		expect(body.includeDomains).toEqual(["example.com"]);
		expect(body.excludeDomains).toEqual(["bad.com"]);
	});

	it("omits domain filters when arrays are empty", () => {
		const body = buildExaRequestBody({
			query: "q",
			include_domains: [],
			exclude_domains: [],
		});
		expect(body.includeDomains).toBeUndefined();
		expect(body.excludeDomains).toBeUndefined();
	});

	it("includes date filters when specified", () => {
		const body = buildExaRequestBody({
			query: "q",
			start_published_date: "2024-01-01",
			end_published_date: "2024-12-31",
		});
		expect(body.startPublishedDate).toBe("2024-01-01");
		expect(body.endPublishedDate).toBe("2024-12-31");
	});
});

describe("synthesizeAnswer", () => {
	it("returns undefined when results array is empty", () => {
		expect(synthesizeAnswer([])).toBeUndefined();
	});

	it("returns undefined when no result has a summary", () => {
		const results = [
			{ title: "A", url: "https://a.com", summary: null },
			{ title: "B", url: "https://b.com", summary: undefined },
			{ title: "C", url: "https://c.com" },
		];
		expect(synthesizeAnswer(results)).toBeUndefined();
	});

	it("returns undefined when summaries are empty strings", () => {
		const results = [
			{ title: "A", url: "https://a.com", summary: "" },
			{ title: "B", url: "https://b.com", summary: "   " },
		];
		expect(synthesizeAnswer(results)).toBeUndefined();
	});

	it("synthesizes answer from a single summary", () => {
		const results = [{ title: "Page One", url: "https://one.com", summary: "Summary of page one." }];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**Page One**: Summary of page one.");
	});

	it("synthesizes answer from multiple summaries joined by double newlines", () => {
		const results = [
			{ title: "A", url: "https://a.com", summary: "Summary A" },
			{ title: "B", url: "https://b.com", summary: "Summary B" },
		];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**A**: Summary A\n\n**B**: Summary B");
	});

	it("skips results with missing summaries but includes ones that have them", () => {
		const results = [
			{ title: "NoSummary", url: "https://no.com", summary: null },
			{ title: "HasSummary", url: "https://yes.com", summary: "Good stuff" },
		];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**HasSummary**: Good stuff");
	});

	it("uses url as fallback title when title is missing", () => {
		const results = [{ url: "https://notitle.com", summary: "Content here" }];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**https://notitle.com**: Content here");
	});

	it("uses 'Untitled' when both title and url are missing", () => {
		const results = [{ summary: "Orphan content" }];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**Untitled**: Orphan content");
	});

	it("trims whitespace from summaries", () => {
		const results = [{ title: "T", url: "https://t.com", summary: "  padded summary  " }];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**T**: padded summary");
	});
});

// ────────────────────────────────────────────────────────────
// Integration tests for searchExa (mock fetch + env)
// ────────────────────────────────────────────────────────────

function makeMockExaResponse(overrides: Record<string, unknown> = {}) {
	return {
		requestId: "req-123",
		resolvedSearchType: "auto",
		results: [
			{
				title: "Page Alpha",
				url: "https://alpha.com",
				author: "Author A",
				publishedDate: "2024-06-01",
				text: "Full text of alpha",
				highlights: ["highlight alpha"],
				summary: "Alpha is about X.",
			},
			{
				title: "Page Beta",
				url: "https://beta.com",
				author: null,
				publishedDate: null,
				text: null,
				highlights: null,
				summary: "Beta covers Y.",
			},
			{
				title: "Page Gamma",
				url: "https://gamma.com",
				author: "Author G",
				publishedDate: "2024-07-15",
				text: "Gamma text",
				highlights: ["gamma hl"],
				summary: "Gamma discusses Z.",
			},
		],
		...overrides,
	};
}

describe("searchExa", () => {
	let capturedRequestBody: Record<string, unknown> | null = null;

	beforeEach(() => {
		capturedRequestBody = null;
		process.env.EXA_API_KEY = "test-key-123";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.EXA_API_KEY;
	});

	function mockFetch(responseBody: unknown, status = 200): Disposable {
		return hookFetch((_url, init) => {
			if (init?.body) {
				capturedRequestBody = JSON.parse(init.body as string);
			}
			return new Response(JSON.stringify(responseBody), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		});
	}

	it("populates answer from per-result summaries", async () => {
		using _hook = mockFetch(makeMockExaResponse());
		const result = await searchExa({ query: "test query" });
		expect(result.provider).toBe("exa");
		expect(result.answer).toBeDefined();
		expect(result.answer).toContain("**Page Alpha**: Alpha is about X.");
		expect(result.answer).toContain("**Page Beta**: Beta covers Y.");
		expect(result.answer).toContain("**Page Gamma**: Gamma discusses Z.");
		expect(result.requestId).toBe("req-123");
	});

	it("returns answer=undefined when no summaries are present", async () => {
		using _hook = mockFetch(
			makeMockExaResponse({ results: [{ title: "No Summary", url: "https://nosummary.com", text: "some text" }] }),
		);
		const result = await searchExa({ query: "no answer query" });
		expect(result.provider).toBe("exa");
		expect(result.answer).toBeUndefined();
		expect(result.sources).toHaveLength(1);
	});

	it("returns answer=undefined when results array is empty", async () => {
		using _hook = mockFetch(makeMockExaResponse({ results: [] }));
		const result = await searchExa({ query: "empty" });
		expect(result.answer).toBeUndefined();
		expect(result.sources).toHaveLength(0);
	});

	it("returns answer=undefined when results is missing from response", async () => {
		using _hook = mockFetch({ requestId: "req-empty" });
		const result = await searchExa({ query: "nothing" });
		expect(result.answer).toBeUndefined();
		expect(result.sources).toHaveLength(0);
	});

	it("sends contents.summary in request body", async () => {
		using _hook = mockFetch(makeMockExaResponse());
		await searchExa({ query: "check body" });
		expect(capturedRequestBody).toBeDefined();
		expect(capturedRequestBody!.contents).toEqual({ summary: { query: "check body" } });
	});

	it("sends correct full request shape", async () => {
		using _hook = mockFetch(makeMockExaResponse());
		await searchExa({ query: "shape test", num_results: 5, type: "neural" });
		expect(capturedRequestBody).toEqual({
			query: "shape test",
			numResults: 5,
			type: "neural",
			contents: { summary: { query: "shape test" } },
		});
	});

	it("prefers summary over text for snippet field", async () => {
		using _hook = mockFetch(
			makeMockExaResponse({
				results: [{ title: "Has Both", url: "https://both.com", text: "full text here", summary: "summary here" }],
			}),
		);
		const result = await searchExa({ query: "snippet test" });
		expect(result.sources[0].snippet).toBe("summary here");
	});

	it("falls back to text when summary is null", async () => {
		using _hook = mockFetch(
			makeMockExaResponse({
				results: [{ title: "Text Only", url: "https://text.com", text: "fallback text", summary: null }],
			}),
		);
		const result = await searchExa({ query: "fallback" });
		expect(result.sources[0].snippet).toBe("fallback text");
	});

	it("falls back to highlights when both summary and text are null", async () => {
		using _hook = mockFetch(
			makeMockExaResponse({
				results: [
					{
						title: "Highlight Only",
						url: "https://hl.com",
						text: null,
						summary: null,
						highlights: ["hl1", "hl2"],
					},
				],
			}),
		);
		const result = await searchExa({ query: "highlights" });
		expect(result.sources[0].snippet).toBe("hl1 hl2");
	});

	it("skips results without url", async () => {
		using _hook = mockFetch(
			makeMockExaResponse({
				results: [
					{ title: "No URL", url: null, summary: "orphan" },
					{ title: "Has URL", url: "https://valid.com", summary: "valid" },
				],
			}),
		);
		const result = await searchExa({ query: "url filter" });
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0].url).toBe("https://valid.com");
	});

	it("falls back to text when summary is empty string (not just null)", async () => {
		using _hook = mockFetch(
			makeMockExaResponse({
				results: [{ title: "Empty Summary", url: "https://empty.com", text: "real text", summary: "" }],
			}),
		);
		const result = await searchExa({ query: "empty summary fallback" });
		expect(result.sources[0].snippet).toBe("real text");
	});

	it("does not include url-less results in synthesized answer", async () => {
		using _hook = mockFetch(
			makeMockExaResponse({
				results: [
					{ title: "No URL", url: null, summary: "ghost summary" },
					{ title: "Has URL", url: "https://valid.com", summary: "real summary" },
				],
			}),
		);
		const result = await searchExa({ query: "url filter answer" });
		expect(result.answer).toBeDefined();
		expect(result.answer).not.toContain("ghost summary");
		expect(result.answer).toContain("**Has URL**: real summary");
	});

	it("requires Exa credentials before starting a search", async () => {
		delete process.env.EXA_API_KEY;
		const fetchSpy = vi.fn(async () => {
			return new Response(JSON.stringify(makeMockExaResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		using _hook = hookFetch(fetchSpy);

		await expect(searchExa({ query: "no key" })).rejects.toThrow(
			"Exa credentials not found. Set EXA_API_KEY or login with 'omp /login exa'.",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("uses AuthStorage credentials when EXA_API_KEY is unset", async () => {
		delete process.env.EXA_API_KEY;
		let receivedKey: string | undefined;
		using _hook = hookFetch((_url, init) => {
			receivedKey = (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
			return new Response(JSON.stringify(makeMockExaResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await withLocalAuthStorage(async authStorage => {
			authStorage.setRuntimeApiKey("exa", "stored-key-xyz");
			const result = await searchExa({ query: "from auth storage", authStorage });
			expect(result.provider).toBe("exa");
			expect(result.sources).toHaveLength(3);
		});
		expect(receivedKey).toBe("stored-key-xyz");
	});

	it("reports unavailable without EXA_API_KEY or stored credentials", async () => {
		delete process.env.EXA_API_KEY;
		const available = await withLocalAuthStorage(authStorage =>
			Promise.resolve(new ExaProvider().isAvailable(authStorage)),
		);
		expect(available).toBe(false);
	});

	it("reports available with EXA_API_KEY", async () => {
		process.env.EXA_API_KEY = "test-key-123";
		const available = await withLocalAuthStorage(authStorage =>
			Promise.resolve(new ExaProvider().isAvailable(authStorage)),
		);
		expect(available).toBe(true);
	});

	it("reports available when AuthStorage holds a credential", async () => {
		delete process.env.EXA_API_KEY;
		const available = await withLocalAuthStorage(authStorage => {
			authStorage.setRuntimeApiKey("exa", "stored-key");
			return Promise.resolve(new ExaProvider().isAvailable(authStorage));
		});
		expect(available).toBe(true);
	});

	it("throws SearchProviderError on non-ok HTTP response", async () => {
		using _hook = mockFetch("Forbidden", 403);
		await expect(searchExa({ query: "forbidden" })).rejects.toThrow("exa: 403 forbidden");
	});
});
