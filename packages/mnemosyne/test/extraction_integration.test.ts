import { afterEach, describe, expect, it } from "bun:test";
import { extractFacts } from "../src/core/extraction";
import { ExtractionClient } from "../src/core/extraction/client";
import { getExtractionStats, resetExtractionStats } from "../src/core/extraction/diagnostics";
import { resetHostLlmBackendForTests } from "../src/core/llm_backends";

const OLD_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnv(): void {
	for (const key in process.env) {
		if (!(key in OLD_ENV)) delete process.env[key];
	}
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
	globalThis.fetch = ORIGINAL_FETCH;
	resetHostLlmBackendForTests();
	resetExtractionStats();
});

describe("extraction integration", () => {
	it("uses a fake OpenAI-compatible remote endpoint for extractFacts", async () => {
		process.env.MNEMOSYNE_LLM_ENABLED = "true";
		process.env.MNEMOSYNE_LLM_BASE_URL = "http://fake-remote/v1";
		let payloadJson = "";
		globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			payloadJson = String(init?.body);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: '{"facts":["Ada prefers deterministic tests"]}' } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const facts = await extractFacts("I prefer deterministic tests.");
		expect(facts).toEqual(["Ada prefers deterministic tests"]);
		const payload = JSON.parse(payloadJson) as {
			temperature?: number;
			messages?: Array<{ content: string }>;
		};
		expect(payload.temperature).toBe(0);
		const firstMessage = payload.messages?.[0];
		if (firstMessage === undefined) throw new Error("expected first request message");
		expect(firstMessage.content).toContain("I prefer deterministic tests");
		expect(getExtractionStats().by_tier.remote.successes).toBe(1);
	});

	it("parses structured fact objects through ExtractionClient with fake HTTP", async () => {
		let requestedUrl = "";
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			requestedUrl = String(input);
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'[{"subject":"Ada","predicate":"prefers","object":"deterministic tests","timestamp":"","source":0,"confidence":0.95}]',
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const client = new ExtractionClient({
			apiKey: "sk-test",
			baseUrl: "http://openrouter.test/api/v1",
		});
		const facts = await client.extractFacts([{ role: "user", content: "Ada prefers deterministic tests." }]);
		expect(requestedUrl).toBe("http://openrouter.test/api/v1/chat/completions");
		expect(facts).toHaveLength(1);
		const fact = facts[0];
		if (fact === undefined) throw new Error("expected one extracted fact");
		expect(fact.subject).toBe("Ada");
		expect(getExtractionStats().totals.successes).toBe(1);
		expect(getExtractionStats().by_tier.cloud.successes).toBe(1);
	});

	it("records malformed cloud JSON as a diagnostic failure", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ choices: [{ message: { content: "Here: [oops, not json]" } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;

		const client = new ExtractionClient({
			apiKey: "sk-test",
			baseUrl: "http://openrouter.test/api/v1",
		});
		expect(await client.extractFacts([{ role: "user", content: "Ada prefers tea." }])).toEqual([]);
		const cloud = getExtractionStats().by_tier.cloud;
		expect(cloud.failures).toBe(1);
		expect(cloud.error_samples.some(sample => sample.reason === "json_parse_failed")).toBe(true);
	});
});
