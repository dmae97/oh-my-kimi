import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleToolCall, TOOLS } from "../src/mcp-tools";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "mnemosyne-ts-provider-parity-"));
	process.env.MNEMOSYNE_DATA_DIR = dataDir;
	process.env.MNEMOSYNE_NO_EMBEDDINGS = "1";
	delete process.env.MNEMOSYNE_MCP_BANK;
	delete process.env.MNEMOSYNE_SHARED_SURFACE_DB;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	delete process.env.MNEMOSYNE_DATA_DIR;
	delete process.env.MNEMOSYNE_NO_EMBEDDINGS;
	delete process.env.MNEMOSYNE_MCP_BANK;
	delete process.env.MNEMOSYNE_SHARED_SURFACE_DB;
});

function schemaFor(name: string) {
	const tool = TOOLS.find(candidate => candidate.name === name);
	expect(tool).toBeDefined();
	return tool?.inputSchema as { required?: readonly string[]; properties: Record<string, unknown> };
}

describe("provider all-tools parity", () => {
	it("registers the Python provider-compatible tool surface with valid JSON schemas", () => {
		const names = TOOLS.map(tool => tool.name);
		expect(names).toHaveLength(23);
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
			expect(names).toContain(name);
		}
		for (const tool of TOOLS) {
			const roundTripped = JSON.parse(JSON.stringify(tool.inputSchema)) as { type: string };
			expect(roundTripped.type).toBe("object");
		}
	});

	it("advertises required arguments for provider write/update/import tools", () => {
		expect(schemaFor("mnemosyne_remember").required).toContain("content");
		expect(schemaFor("mnemosyne_recall").required).toContain("query");
		expect(schemaFor("mnemosyne_scratchpad_write").required).toContain("content");
		expect(schemaFor("mnemosyne_update").required).toEqual(["memory_id", "content"]);
		expect(schemaFor("mnemosyne_forget").required).toContain("memory_id");
		expect(schemaFor("mnemosyne_export").required).toContain("output_path");
		expect(schemaFor("mnemosyne_import").required).toContain("input_path");
	});

	it("returns user-facing argument errors instead of mutating on missing arguments", () => {
		for (const [name, args, expected] of [
			["mnemosyne_remember", {}, "content is required"],
			["mnemosyne_recall", {}, "query is required"],
			["mnemosyne_scratchpad_write", { content: "" }, "content is required"],
			["mnemosyne_update", { memory_id: "missing-id" }, "content or importance is required"],
			["mnemosyne_forget", {}, "memory_id is required"],
			["mnemosyne_export", {}, "output_path is required"],
			["mnemosyne_import", {}, "Either input_path (for file import) is required"],
		] as const) {
			const result = handleToolCall(name, args);
			expect(result.error).toBe(expected);
		}
	});

	it("exports provider data to a file and imports it into a fresh isolated bank", () => {
		const remembered = handleToolCall("mnemosyne_remember", {
			content: "source provider memory for import parity",
			importance: 0.7,
			bank: "source",
		});
		expect(remembered.status).toBe("stored");
		handleToolCall("mnemosyne_scratchpad_write", {
			content: "portable provider scratch",
			bank: "source",
		});

		const exportPath = join(dataDir, "provider-export.json");
		const exported = handleToolCall("mnemosyne_export", {
			output_path: exportPath,
			bank: "source",
		});
		expect(exported.status).toBe("exported");
		expect(existsSync(exportPath)).toBe(true);
		const payload = JSON.parse(readFileSync(exportPath, "utf8")) as { working_memory?: unknown[] };
		expect(payload.working_memory?.length).toBe(1);

		const imported = handleToolCall("mnemosyne_import", { input_path: exportPath, bank: "dest" });
		expect(imported.status).toBe("imported");
		expect(JSON.stringify(imported.stats)).toContain("inserted");
		const recalled = handleToolCall("mnemosyne_recall", {
			query: "import parity",
			bank: "dest",
			limit: 5,
		});
		expect(recalled.count as number).toBeGreaterThanOrEqual(1);
	});

	it("diagnose, validate, graph, and shared handlers return structured provider results", () => {
		const remembered = handleToolCall("mnemosyne_remember", {
			content: "validate me through provider parity",
			bank: "ops",
		});
		const memoryId = remembered.memory_id as string;
		const validate = handleToolCall("mnemosyne_validate", {
			memory_id: memoryId,
			action: "attest",
			validator: "test",
			bank: "ops",
		});
		expect(validate.status).toBe("validation_attest");
		const diagnose = handleToolCall("mnemosyne_diagnose", { bank: "ops" });
		expect(diagnose.status).toBe("ok");
		expect(diagnose.db_path).toContain("banks/ops/mnemosyne.db");
		const graphQuery = handleToolCall("mnemosyne_graph_query", { seed_memory_id: memoryId, bank: "ops" });
		expect(graphQuery).toMatchObject({
			status: "ok",
			seed_memory_id: memoryId,
			count: 0,
			results_count: 0,
			results: [],
			related_memories: [],
			bank: "ops",
		});
		expect(
			handleToolCall("mnemosyne_graph_link", {
				source_id: memoryId,
				target_id: "other",
				relationship: "related",
				bank: "ops",
			}),
		).toMatchObject({
			status: "linked",
			source_id: memoryId,
			target_id: "other",
			relationship: "related",
			edge_type: "related",
			weight: 0.5,
			bank: "ops",
		});

		const shared = handleToolCall("mnemosyne_shared_remember", {
			content: "Prefer concise parity notes",
			kind: "preference",
		});
		expect(shared.status).toBe("stored_shared");
		expect(handleToolCall("mnemosyne_shared_forget", { memory_id: shared.memory_id }).status).toBe("deleted");
	});
});
