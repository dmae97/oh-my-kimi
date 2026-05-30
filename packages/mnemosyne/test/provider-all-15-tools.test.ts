import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleToolCall, TOOLS } from "../src/mcp-tools";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "mnemosyne-provider-tools-"));
	process.env.MNEMOSYNE_DATA_DIR = dataDir;
	process.env.MNEMOSYNE_NO_EMBEDDINGS = "1";
	delete process.env.MNEMOSYNE_MCP_BANK;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	delete process.env.MNEMOSYNE_DATA_DIR;
	delete process.env.MNEMOSYNE_NO_EMBEDDINGS;
	delete process.env.MNEMOSYNE_MCP_BANK;
});

function toolNames(): Set<string> {
	return new Set(TOOLS.map(tool => tool.name));
}

describe("all provider-compatible MCP tools", () => {
	it("registers all 23 real tool names", () => {
		const names = toolNames();
		expect(names.size).toBe(23);
		for (const name of [
			"mnemosyne_remember",
			"mnemosyne_recall",
			"mnemosyne_sleep",
			"mnemosyne_stats",
			"mnemosyne_invalidate",
			"mnemosyne_validate",
			"mnemosyne_get",
			"mnemosyne_triple_add",
			"mnemosyne_triple_query",
			"mnemosyne_scratchpad_write",
			"mnemosyne_scratchpad_read",
			"mnemosyne_scratchpad_clear",
			"mnemosyne_export",
			"mnemosyne_update",
			"mnemosyne_forget",
			"mnemosyne_import",
			"mnemosyne_diagnose",
			"mnemosyne_shared_remember",
			"mnemosyne_shared_recall",
			"mnemosyne_shared_forget",
			"mnemosyne_shared_stats",
			"mnemosyne_graph_query",
			"mnemosyne_graph_link",
		]) {
			expect(names.has(name)).toBe(true);
		}
	});

	it("rejects unknown tools", () => {
		expect(() => handleToolCall("mnemosyne_nonexistent", {})).toThrow("Unknown tool");
	});
});

describe("representative provider-compatible handlers", () => {
	it("stores, recalls, reads stats, updates, gets, invalidates, and forgets", () => {
		const remembered = handleToolCall("mnemosyne_remember", {
			content: "Provider handler stores durable espresso preference",
			importance: 0.7,
			bank: "provider",
		});
		const memoryId = remembered.memory_id as string;
		expect(remembered.status).toBe("stored");
		expect(memoryId).toHaveLength(16);

		const recalled = handleToolCall("mnemosyne_recall", {
			query: "espresso preference",
			limit: 5,
			bank: "provider",
		});
		expect(recalled.status).toBe("ok");
		expect(recalled.count as number).toBeGreaterThanOrEqual(1);

		const updated = handleToolCall("mnemosyne_update", {
			memory_id: memoryId,
			content: "Provider handler stores durable tea preference",
			bank: "provider",
		});
		expect(updated.status).toBe("updated");
		const got = handleToolCall("mnemosyne_get", { memory_id: memoryId, bank: "provider" });
		expect(got.status).toBe("ok");
		expect(JSON.stringify(got.memory)).toContain("tea preference");

		const stats = handleToolCall("mnemosyne_stats", { bank: "provider" });
		expect(stats.status).toBe("ok");
		expect(stats.working).toBeDefined();

		const invalidated = handleToolCall("mnemosyne_invalidate", {
			memory_id: memoryId,
			bank: "provider",
		});
		expect(invalidated.status).toBe("invalidated");
		const forgotten = handleToolCall("mnemosyne_forget", { memory_id: memoryId, bank: "provider" });
		expect(forgotten.status).toBe("deleted");
	});

	it("handles sleep and scratchpad operations", () => {
		const write = handleToolCall("mnemosyne_scratchpad_write", {
			content: "provider scratch",
			bank: "provider",
		});
		expect(write.status).toBe("written");
		const read = handleToolCall("mnemosyne_scratchpad_read", { bank: "provider" });
		expect(read.entries_count as number).toBe(1);
		const clear = handleToolCall("mnemosyne_scratchpad_clear", { bank: "provider" });
		expect(clear.status).toBe("cleared");
		const sleep = handleToolCall("mnemosyne_sleep", { dry_run: true, bank: "provider" });
		expect(sleep.status).toBe("ok");
		expect(sleep.dry_run).toBe(true);
	});

	it("handles bank-isolated operations", () => {
		handleToolCall("mnemosyne_remember", {
			content: "only alpha bank contains apricot",
			bank: "alpha",
		});
		const alpha = handleToolCall("mnemosyne_recall", { query: "apricot", bank: "alpha" });
		const beta = handleToolCall("mnemosyne_recall", { query: "apricot", bank: "beta" });
		expect(alpha.count as number).toBeGreaterThanOrEqual(1);
		expect(beta.count).toBe(0);
	});

	it("handles triple and shared-surface tools", () => {
		const triple = handleToolCall("mnemosyne_triple_add", {
			subject: "user",
			predicate: "prefers",
			object: "oolong",
			bank: "provider",
		});
		expect(triple.status).toBe("stored");
		const triples = handleToolCall("mnemosyne_triple_query", {
			subject: "user",
			predicate: "prefers",
			bank: "provider",
		});
		expect(triples.results_count as number).toBeGreaterThanOrEqual(1);

		const shared = handleToolCall("mnemosyne_shared_remember", {
			content: "User prefers concise answers",
			kind: "preference",
		});
		expect(shared.status).toBe("stored_shared");
		const sharedRecall = handleToolCall("mnemosyne_shared_recall", { query: "concise answers" });
		expect(sharedRecall.count as number).toBeGreaterThanOrEqual(1);
		const sharedStats = handleToolCall("mnemosyne_shared_stats", {});
		expect(sharedStats.provider).toBe("mnemosyne_shared");
	});
});
