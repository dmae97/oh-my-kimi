import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction";
import {
	DEFAULT_PRUNE_CONFIG,
	pruneSupersededToolResults,
	pruneToolOutputs,
	readToolSupersedeKey,
	SUPERSEDED_NOTICE,
	type SupersedePruneConfig,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { ProtectedToolContext } from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";

let idCounter = 0;
function nextId(): string {
	return `entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage, timestamp: number): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date(timestamp).toISOString(), message };
}

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function toolResultMessage(toolName: string, toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** Assistant toolCall entry + paired toolResult entry for one read. */
function readPair(path: string, text: string, timestamp: number): [SessionMessageEntry, SessionMessageEntry] {
	const callId = `call-${idCounter++}`;
	return [
		messageEntry(
			assistantMessage([{ type: "toolCall", id: callId, name: "read", arguments: { path } }], timestamp),
			timestamp,
		),
		messageEntry(toolResultMessage("read", callId, text, timestamp), timestamp),
	];
}

function textEntry(text: string, timestamp: number): SessionMessageEntry {
	return messageEntry(assistantMessage([{ type: "text", text }], timestamp), timestamp);
}

function resultText(entry: SessionEntry): string {
	const message = (entry as SessionMessageEntry).message as ToolResultMessage;
	return (message.content[0] as TextContent).text;
}

function resultMessage(entry: SessionEntry): ToolResultMessage {
	return (entry as SessionMessageEntry).message as ToolResultMessage;
}

function cfg(over: Partial<SupersedePruneConfig> = {}): SupersedePruneConfig {
	return { supersedeKey: readToolSupersedeKey, protectedTools: [], ...over };
}

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);
const FILE_CONTENT = "export function alpha() { return 1; }\n".repeat(50);
// Comfortably above any small suffixTokenLimit used below.
const BIG_TEXT = "const value = computeSomething(12345);\n".repeat(500);

describe("readToolSupersedeKey", () => {
	test("bare path keys on itself; non-read and non-string paths are exempt", () => {
		expect(readToolSupersedeKey("read", { path: "src/foo.ts" })).toBe("src/foo.ts");
		expect(readToolSupersedeKey("bash", { path: "src/foo.ts" })).toBeUndefined();
		expect(readToolSupersedeKey("read", { path: 42 })).toBeUndefined();
		expect(readToolSupersedeKey("read", {})).toBeUndefined();
	});

	test("URL/internal schemes are exempt", () => {
		expect(readToolSupersedeKey("read", { path: "skill://react" })).toBeUndefined();
		expect(readToolSupersedeKey("read", { path: "https://example.com/page" })).toBeUndefined();
	});

	test("strips trailing selectors into a \\u0000-separated key", () => {
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:50-200" })).toBe("src/foo.ts\u000050-200");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:raw" })).toBe("src/foo.ts\u0000raw");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:conflicts" })).toBe("src/foo.ts\u0000conflicts");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:2-4:raw" })).toBe("src/foo.ts\u00002-4:raw");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:5-16,960-973" })).toBe("src/foo.ts\u00005-16,960-973");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:50+150" })).toBe("src/foo.ts\u000050+150");
	});

	test("does not strip non-selector colon segments", () => {
		expect(readToolSupersedeKey("read", { path: "db.sqlite:users" })).toBe("db.sqlite:users");
		expect(readToolSupersedeKey("read", { path: "db.sqlite:users:42" })).toBe("db.sqlite:users\u000042");
	});
});

describe("pruneSupersededToolResults — tail case", () => {
	test("(a) older identical-path read pruned with exact placeholder when suffix small", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneSupersededToolResults(entries, cfg({ now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(1);
		expect(result.tokensSaved).toBeGreaterThan(0);
		expect(resultText(result1)).toBe("[Superseded by a newer read of this file]");
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultMessage(result1).prunedAt).toBeDefined();
		// Latest read untouched.
		expect(resultText(result2)).toBe(FILE_CONTENT);
		expect(resultMessage(result2).prunedAt).toBeUndefined();
	});

	test("(b) NOT pruned when suffix exceeds limit and no idle gap", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const big = textEntry(BIG_TEXT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, big];

		const result = pruneSupersededToolResults(entries, cfg({ suffixTokenLimit: 200, now: T0 + 2_000 }));

		expect(result.prunedCount).toBe(0);
		expect(result.tokensSaved).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
		expect(resultMessage(result1).prunedAt).toBeUndefined();
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("(c) idle gap prunes all candidates regardless of suffix", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/bar.ts", FILE_CONTENT, T0 + 1_000);
		const [call3, result3] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000);
		const [call4, result4] = readPair("src/bar.ts", FILE_CONTENT, T0 + 3_000);
		const big = textEntry(BIG_TEXT, T0 + 4_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3, call4, result4, big];

		// Suffix limit 0 would block every candidate; only the idle gap fires.
		const result = pruneSupersededToolResults(
			entries,
			cfg({ suffixTokenLimit: 0, idleFlushMs: 30 * 60_000, now: T0 + 4_000 + 30 * 60_000 }),
		);

		expect(result.prunedCount).toBe(2);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result3)).toBe(FILE_CONTENT);
		expect(resultText(result4)).toBe(FILE_CONTENT);
	});

	test("no idle flush when gap is below the threshold", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const big = textEntry(BIG_TEXT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, big];

		const result = pruneSupersededToolResults(
			entries,
			cfg({ suffixTokenLimit: 0, idleFlushMs: 30 * 60_000, now: T0 + 2_000 + 29 * 60_000 }),
		);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});
});

describe("pruneSupersededToolResults — selectors", () => {
	test("(d) different range selectors do not supersede each other; a later selector-free read supersedes them", () => {
		const [callA, resultA] = readPair("src/foo.ts:50-200", FILE_CONTENT, T0);
		const [callB, resultB] = readPair("src/foo.ts:10-20", FILE_CONTENT, T0 + 1_000);
		let entries: SessionEntry[] = [callA, resultA, callB, resultB];

		// Different selectors: no candidates.
		let result = pruneSupersededToolResults(entries, cfg({ now: T0 + 1_000 }));
		expect(result.prunedCount).toBe(0);
		expect(resultText(resultA)).toBe(FILE_CONTENT);
		expect(resultText(resultB)).toBe(FILE_CONTENT);

		// Identical selector strings DO supersede.
		const [callA2, resultA2] = readPair("src/foo.ts:50-200", FILE_CONTENT, T0 + 2_000);
		entries = [...entries, callA2, resultA2];
		result = pruneSupersededToolResults(entries, cfg({ now: T0 + 2_000 }));
		expect(result.prunedCount).toBe(1);
		expect(resultText(resultA)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultB)).toBe(FILE_CONTENT);
		expect(resultText(resultA2)).toBe(FILE_CONTENT);

		// A later selector-free read supersedes every selector-carrying read of the base path.
		const [callFull, resultFull] = readPair("src/foo.ts", FILE_CONTENT, T0 + 3_000);
		entries = [...entries, callFull, resultFull];
		result = pruneSupersededToolResults(entries, cfg({ now: T0 + 3_000 }));
		expect(result.prunedCount).toBe(2);
		expect(resultText(resultB)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultA2)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultFull)).toBe(FILE_CONTENT);
	});

	test("a selector-carrying read does NOT supersede an earlier selector-free read", () => {
		const [callFull, resultFull] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [callRange, resultRange] = readPair("src/foo.ts:50-200", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [callFull, resultFull, callRange, resultRange];

		const result = pruneSupersededToolResults(entries, cfg({ now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(resultFull)).toBe(FILE_CONTENT);
		expect(resultText(resultRange)).toBe(FILE_CONTENT);
	});
});

describe("pruneSupersededToolResults — protection & latest", () => {
	test("(e) latest read never pruned, even with idle flush", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const [call3, result3] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3];

		const result = pruneSupersededToolResults(entries, cfg({ now: T0 + 2_000 + 60 * 60_000 }));

		expect(result.prunedCount).toBe(2);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result3)).toBe(FILE_CONTENT);
		expect(resultMessage(result3).prunedAt).toBeUndefined();
	});

	test("(f) protected tool results never pruned", () => {
		const protectPlan = ({ toolCall }: ProtectedToolContext): boolean =>
			(toolCall?.arguments as Record<string, unknown> | undefined)?.path === "plan.md";
		const [planCall1, planResult1] = readPair("plan.md", FILE_CONTENT, T0);
		const [fooCall1, fooResult1] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const [planCall2, planResult2] = readPair("plan.md", FILE_CONTENT, T0 + 2_000);
		const [fooCall2, fooResult2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 3_000);
		const entries: SessionEntry[] = [
			planCall1,
			planResult1,
			fooCall1,
			fooResult1,
			planCall2,
			planResult2,
			fooCall2,
			fooResult2,
		];

		const result = pruneSupersededToolResults(entries, cfg({ protectedTools: [protectPlan], now: T0 + 3_000 }));

		expect(result.prunedCount).toBe(1);
		expect(resultText(planResult1)).toBe(FILE_CONTENT);
		expect(resultText(planResult2)).toBe(FILE_CONTENT);
		expect(resultText(fooResult1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(fooResult2)).toBe(FILE_CONTENT);
	});

	test("already-pruned results are ignored as candidates and as superseders", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		resultMessage(result2).prunedAt = T0 + 1_500;
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		// The only newer same-key read is itself pruned -> result1 has no live superseder.
		const result = pruneSupersededToolResults(entries, cfg({ now: T0 + 2_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
	});
});

describe("pruneToolOutputs — supersede priority fold", () => {
	test("with supersedeKey, superseded results bypass the protect window and get the supersede placeholder", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneToolOutputs(entries, {
			protectTokens: 1_000_000, // everything inside the protect window
			minimumSavings: 0,
			protectedTools: [],
			supersedeKey: readToolSupersedeKey,
		});

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("(g) without supersedeKey, behavior is unchanged (regression guard)", () => {
		const buildEntries = (): {
			entries: SessionEntry[];
			oldResult: SessionMessageEntry;
			newResult: SessionMessageEntry;
		} => {
			const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
			const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
			return { entries: [call1, result1, call2, result2], oldResult: result1, newResult: result2 };
		};

		// Protect window covers everything: nothing pruned, superseded reads included.
		const protectedFixture = buildEntries();
		const protectedRun = pruneToolOutputs(protectedFixture.entries, {
			protectTokens: 1_000_000,
			minimumSavings: 0,
			protectedTools: [],
		});
		expect(protectedRun).toEqual({ prunedCount: 0, tokensSaved: 0 });
		expect(resultText(protectedFixture.oldResult)).toBe(FILE_CONTENT);
		expect(resultText(protectedFixture.newResult)).toBe(FILE_CONTENT);

		// Protect window empty: every result past it pruned with the legacy
		// truncation placeholder — never the supersede placeholder.
		const unprotectedFixture = buildEntries();
		const unprotectedRun = pruneToolOutputs(unprotectedFixture.entries, {
			protectTokens: 0,
			minimumSavings: 0,
			protectedTools: [],
		});
		expect(unprotectedRun.prunedCount).toBe(2);
		expect(resultText(unprotectedFixture.oldResult)).toMatch(/^\[Output truncated - \d+ tokens\]$/);
		expect(resultText(unprotectedFixture.newResult)).toMatch(/^\[Output truncated - \d+ tokens\]$/);

		// Default config shape is untouched.
		expect(DEFAULT_PRUNE_CONFIG.supersedeKey).toBeUndefined();
		expect(DEFAULT_PRUNE_CONFIG.protectTokens).toBe(40_000);
		expect(DEFAULT_PRUNE_CONFIG.minimumSavings).toBe(20_000);
	});
});
