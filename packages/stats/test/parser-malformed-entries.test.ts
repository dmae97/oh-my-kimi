import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { initDb, insertMessageStats, insertToolCalls } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-malformed-");

const USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantEntry(id: string, message: Record<string, unknown>): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-07-12T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			...message,
		},
	});
}

async function writeSession(lines: string[]): Promise<string> {
	const dir = path.join(getSessionsDir(), "--tmp--malformed");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, `${lines.join("\n")}\n`);
	return file;
}

// Regression: a single persisted assistant message missing `stopReason` (or
// usage/token fields) used to bind NULL into stats.db's NOT NULL columns and
// crash the entire sync with SQLITE_CONSTRAINT_NOTNULL. The parser must
// coerce or skip malformed entries so the batch always inserts.
describe("malformed session entries", () => {
	it("coerces a missing stopReason instead of failing the NOT NULL insert", async () => {
		const file = await writeSession([
			assistantEntry("a1", { content: [{ type: "text", text: "hi" }], usage: USAGE, timestamp: 1752000000000 }),
			assistantEntry("a2", {
				content: [],
				usage: USAGE,
				timestamp: 1752000001000,
				errorMessage: "boom",
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.stopReason)).toEqual(["aborted", "error"]);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(2);
	});

	it("zero-fills missing token counts and falls back to the entry timestamp", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [],
				stopReason: "stop",
				usage: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(1);
		const stats = result.stats[0];
		expect(stats.usage.totalTokens).toBe(0);
		expect(stats.timestamp).toBe(Date.parse("2026-07-12T00:00:00.000Z"));

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
	});

	it("skips assistant entries with no usage or model attribution", async () => {
		const file = await writeSession([
			assistantEntry("a1", { content: [], stopReason: "stop" }),
			JSON.stringify({
				type: "message",
				id: "a2",
				timestamp: "2026-07-12T00:00:00.000Z",
				message: { role: "assistant", content: [], stopReason: "stop", usage: USAGE },
			}),
			assistantEntry("ok", { content: [], stopReason: "stop", usage: USAGE, timestamp: 1752000002000 }),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.entryId)).toEqual(["ok"]);
	});

	it("keeps tool_calls insertable when the turn lacks a message timestamp", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
					{ type: "toolCall", name: "broken" }, // no id: unattributable, must be skipped
				],
				usage: USAGE,
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.toolCalls.map(c => c.toolCallId)).toEqual(["call-1"]);
		expect(result.toolCalls[0].timestamp).toBe(Date.parse("2026-07-12T00:00:00.000Z"));

		await initDb();
		expect(insertToolCalls(result.toolCalls)).toBe(1);
	});
});
