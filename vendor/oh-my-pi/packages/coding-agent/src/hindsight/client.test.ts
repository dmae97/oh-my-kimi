import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "./client";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("HindsightApi fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("combines caller cancellation with the request timeout", async () => {
		let requestSignal: AbortSignal | undefined;
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ results: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const caller = new AbortController();
		const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
		await client.recall("bank", "query", { signal: caller.signal });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
		expect(requestSignal).not.toBe(caller.signal);
		caller.abort(new Error("caller aborted"));
		expect(requestSignal?.aborted).toBe(true);
		expect(requestSignal?.reason).toBe(caller.signal.reason);
	});
});
