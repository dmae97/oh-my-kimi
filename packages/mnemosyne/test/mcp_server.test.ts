import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callToolJson, handleJsonRpc } from "../src/mcp_server";
import { getToolDefinitions, handleToolCall, TOOLS } from "../src/mcp_tools";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "mnemosyne-mcp-server-"));
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

describe("MCP tool definitions", () => {
	it("exposes the full realistic tool surface", () => {
		const names = TOOLS.map(tool => tool.name);
		expect(names).toHaveLength(23);
		expect(names).toEqual([
			"mnemosyne_remember",
			"mnemosyne_recall",
			"mnemosyne_shared_remember",
			"mnemosyne_shared_recall",
			"mnemosyne_shared_forget",
			"mnemosyne_shared_stats",
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
			"mnemosyne_graph_query",
			"mnemosyne_graph_link",
		]);
	});

	it("returns JSON-serializable MCP schemas", () => {
		const tools = getToolDefinitions();
		expect(tools).toHaveLength(23);
		for (const tool of tools) {
			const schema = JSON.parse(JSON.stringify(tool.inputSchema)) as {
				type: string;
				properties: unknown;
			};
			expect(schema.type).toBe("object");
			expect(schema.properties).toBeDefined();
		}
	});
});

describe("MCP JSON handlers", () => {
	it("lists tools through JSON-RPC", () => {
		const response = handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		expect(response.error).toBeUndefined();
		expect((response.result as { tools: unknown[] }).tools).toHaveLength(23);
	});

	it("wraps tool results in MCP text content", () => {
		const response = callToolJson("mnemosyne_stats", { bank: "server" });
		expect(response.isError).toBeUndefined();
		const payload = JSON.parse(response.content[0]?.text ?? "{}") as {
			status: string;
			bank: string;
		};
		expect(payload.status).toBe("ok");
		expect(payload.bank).toBe("server");
	});

	it("dispatches remember, recall, stats, sleep, scratchpad, and bank operations", () => {
		const remembered = handleToolCall("mnemosyne_remember", {
			content: "MCP server test remembers kombucha preference",
			importance: 0.8,
			bank: "work",
		});
		expect(remembered.status).toBe("stored");
		expect(remembered.bank).toBe("work");
		expect(typeof remembered.memory_id).toBe("string");

		const recalled = handleToolCall("mnemosyne_recall", {
			query: "kombucha preference",
			top_k: 3,
			bank: "work",
		});
		expect(recalled.status).toBe("ok");
		expect(recalled.bank).toBe("work");
		expect(recalled.count as number).toBeGreaterThanOrEqual(1);

		const scratchWrite = handleToolCall("mnemosyne_scratchpad_write", {
			content: "scratch note",
			bank: "work",
		});
		expect(scratchWrite.status).toBe("written");
		expect(scratchWrite.bank).toBe("work");
		const scratchRead = handleToolCall("mnemosyne_scratchpad_read", { bank: "work" });
		expect(scratchRead.entries_count as number).toBeGreaterThanOrEqual(1);

		const stats = handleToolCall("mnemosyne_stats", { bank: "work" });
		expect(stats.status).toBe("ok");
		expect(stats.bank).toBe("work");
		expect(stats.working).toBeDefined();

		const sleep = handleToolCall("mnemosyne_sleep", { dry_run: true, bank: "work" });
		expect(sleep.status).toBe("ok");
		expect(sleep.dry_run).toBe(true);
		expect(sleep.bank).toBe("work");
	});

	it("uses MNEMOSYNE_MCP_BANK when a call omits bank", () => {
		process.env.MNEMOSYNE_MCP_BANK = "env-bank";
		const remembered = handleToolCall("mnemosyne_remember", { content: "env bank memory" });
		expect(remembered.bank).toBe("env-bank");
		const stats = handleToolCall("mnemosyne_stats", {});
		expect(stats.bank).toBe("env-bank");
	});
});
