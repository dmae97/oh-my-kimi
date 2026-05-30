import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extraction_rate, normalize_batch, normalize_chat } from "../src/core/chat_normalize";
import { get_cost_stats, init_cost_log, log_cost } from "../src/core/cost_log";
import { estimate_cost, estimate_tokens } from "../src/core/token_counter";

describe("token counter", () => {
	it("uses the Python fallback token estimate and pricing table", () => {
		expect(estimate_tokens("")).toBe(0);
		expect(estimate_tokens("abcdefghijkl")).toBe(3);
		expect(estimate_tokens("abc")).toBe(0);
		expect(estimate_cost(1_000_000, "gpt-4o-mini")).toEqual({
			tokens: 1_000_000,
			model: "gpt-4o-mini",
			cost_usd: 0.15,
			rate_per_1m: 0.15,
		});
		expect(estimate_cost(333, "unknown-model")).toEqual({
			tokens: 333,
			model: "unknown-model",
			cost_usd: 0.000999,
			rate_per_1m: 3.0,
		});
	});
});

describe("cost log", () => {
	it("initializes the sqlite table and aggregates all and per-session stats", () => {
		const dbPath = join(mkdtempSync(join(tmpdir(), "mnemosyne-cost-")), "cost_log.db");

		init_cost_log(dbPath);
		log_cost("session-a", 2, 100, 0.0003, "default", dbPath);
		log_cost("session-a", 3, 200, 0.0006, "claude-sonnet-4", dbPath);
		log_cost("session-b", 5, 400, 0.0012, "gpt-4o", dbPath);

		expect(get_cost_stats("session-a", dbPath)).toEqual({
			total_calls: 2,
			total_memories_injected: 5,
			total_tokens: 300,
			total_estimated_cost_usd: 0.0009,
		});
		expect(get_cost_stats(undefined, dbPath)).toEqual({
			total_calls: 3,
			total_memories_injected: 10,
			total_tokens: 700,
			total_estimated_cost_usd: 0.0021,
		});
		expect(get_cost_stats("missing", dbPath)).toEqual({
			total_calls: 0,
			total_memories_injected: 0,
			total_tokens: 0,
			total_estimated_cost_usd: 0,
		});
	});
});

describe("chat normalization", () => {
	it("expands contractions, strips fillers, collapses repeated chars, and removes non-ascii", () => {
		expect(normalize_chat("LOL u gonna loooove this 🚀")).toBe("you going to love this");
		expect(normalize_chat("omggg!!!")).toBeNull();
		expect(normalize_chat("DUNNO whyyyy")).toBe("don't know why");
	});

	it("drops fragments but preserves long single words and optional implicit subjects", () => {
		expect(normalize_chat("hi")).toBeNull();
		expect(normalize_chat("memoria")).toBe("memoria");
		expect(normalize_chat("going home")).toBe("i am going home");
		expect(normalize_chat("going home", { add_implicit_subjects: false })).toBe("going home");
		expect(normalize_chat("working on parser")).toBe("working on parser");
	});

	it("normalizes batches and reports extraction rate with dropped samples", () => {
		expect(normalize_batch(["lol", "building cache", "OpenWebUI"])).toEqual([
			null,
			"i am building cache",
			"openwebui",
		]);
		expect(extraction_rate(["lol", "brb", "building cache", "OpenWebUI"])).toEqual({
			total: 4,
			survived: 2,
			dropped: 2,
			rate: 0.5,
			dropped_samples: ["lol", "brb"],
		});
	});
});
