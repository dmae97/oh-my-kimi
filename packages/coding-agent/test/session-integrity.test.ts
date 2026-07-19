import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as currentAgentCore from "../../agent/src/index.ts";
import { inspectSessionIntegrity, type SessionIntegrityReasonCode } from "../src/core/session-integrity.ts";

vi.mock("omk-agent-core", () => currentAgentCore);

const encoder = new TextEncoder();
const header = {
	type: "session",
	version: 3,
	id: "session-1",
	timestamp: "2026-07-15T00:00:00.000Z",
	cwd: "/workspace",
};

function user(text: string) {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(toolCallId?: string) {
	return {
		role: "assistant",
		content: toolCallId
			? [{ type: "toolCall", id: toolCallId, name: "echo", arguments: {} }]
			: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCallId ? "toolUse" : "stop",
		timestamp: 1,
	};
}

function toolResult(toolCallId: string) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "echo",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 1,
	};
}

function bashExecution() {
	return {
		role: "bashExecution",
		command: "pwd",
		output: "/workspace",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	};
}

function customMessage() {
	return {
		role: "custom",
		customType: "notice",
		content: [{ type: "text", text: "custom" }],
		display: true,
		timestamp: 1,
	};
}

function branchSummary() {
	return { role: "branchSummary", summary: "branch", fromId: "from", timestamp: 1 };
}

function compactionSummary() {
	return { role: "compactionSummary", summary: "compact", tokensBefore: 10, timestamp: 1 };
}

function entry(id: string, parentId: string | null, message: unknown = user(id)) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-15T00:00:00.000Z",
		message,
	};
}

function compactionEntry(id: string, parentId: string | null, firstKeptEntryId: string) {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-07-15T00:00:00.000Z",
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 10,
	};
}

function jsonl(records: readonly unknown[]): Uint8Array {
	return encoder.encode(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function reasons(report: { findings: readonly { reason: SessionIntegrityReasonCode }[] }) {
	return report.findings.map((finding) => finding.reason);
}

describe("inspectSessionIntegrity", () => {
	it("uses transcript integrity through the package-agent source root", () => {
		expect(currentAgentCore.inspectTranscriptIntegrity).toBeTypeOf("function");
		expect(currentAgentCore.repairTranscriptIntegrity).toBeTypeOf("function");
		expect(currentAgentCore.createSyntheticToolResult).toBeTypeOf("function");
		expect(currentAgentCore.TranscriptIntegrityError).toBeTypeOf("function");
	});

	it("preserves the exact complete prefix and ordered active branch", () => {
		const bytes = jsonl([header, entry("u", null, user("hi")), entry("a", "u", assistant())]);
		const before = Uint8Array.from(bytes);
		const report = inspectSessionIntegrity(bytes);

		expect(report.ok).toBe(true);
		expect(report.entries.map((value) => value.id)).toEqual(["u", "a"]);
		expect(report.activeLeafId).toBe("a");
		expect(report.activeBranch.map((value) => value.id)).toEqual(["u", "a"]);
		expect(report.transcript).toEqual({ ok: true, issues: [] });
		expect(report.completePrefix.byteCount).toBe(bytes.byteLength);
		expect(report.completePrefix.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(report.source.sha256).toBe(report.completePrefix.sha256);
		expect(bytes).toEqual(before);
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.entries)).toBe(true);
	});

	it("accepts every current core and coding-agent message role", () => {
		const records = [
			header,
			entry("user", null, user("hi")),
			entry("call", "user", assistant("call-1")),
			entry("result", "call", toolResult("call-1")),
			entry("bash", "result", bashExecution()),
			entry("custom", "bash", customMessage()),
			entry("branch", "custom", branchSummary()),
			entry("compaction", "branch", compactionSummary()),
		];
		const report = inspectSessionIntegrity(jsonl(records));
		expect(report.ok).toBe(true);
		expect(report.activeMessages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"bashExecution",
			"custom",
			"branchSummary",
			"compactionSummary",
		]);
	});

	it.each([
		["user", () => ({ ...user("bad"), content: [{ type: "thinking", thinking: "no" }] })],
		[
			"assistant",
			() => {
				const message = assistant();
				return { ...message, usage: { ...message.usage, totalTokens: -1 } };
			},
		],
		["toolResult", () => ({ ...toolResult("call"), isError: "false" })],
		["bashExecution", () => ({ ...bashExecution(), cancelled: "false" })],
		["custom", () => ({ ...customMessage(), display: "true" })],
		["branchSummary", () => ({ ...branchSummary(), fromId: "" })],
		["compactionSummary", () => ({ ...compactionSummary(), tokensBefore: -1 })],
		["unknown", () => ({ role: "futureRole", timestamp: 1 })],
	] as const)("rejects malformed %s messages", (_role, createMessage) => {
		const report = inspectSessionIntegrity(jsonl([header, entry("bad", null, createMessage())]));
		expect(reasons(report)).toContain("invalid_entry");
		expect(report.transcript).toBeNull();
	});

	it("rejects negative or non-finite timestamps for every current role", () => {
		const messages = [
			user("bad"),
			assistant(),
			toolResult("call"),
			bashExecution(),
			customMessage(),
			branchSummary(),
			compactionSummary(),
		];
		for (const [index, message] of messages.entries()) {
			const timestamp = index === 0 ? Number.POSITIVE_INFINITY : -1;
			const report = inspectSessionIntegrity(
				jsonl([header, entry(`bad-${index}`, null, { ...message, timestamp })]),
			);
			expect(reasons(report)).toContain("invalid_entry");
			expect(report.transcript).toBeNull();
		}
	});

	it("treats a newline-free valid final record as a trailing fragment", () => {
		const complete = jsonl([header, entry("u", null)]);
		const fragment = encoder.encode(JSON.stringify(entry("a", "u", assistant())));
		const bytes = new Uint8Array(complete.byteLength + fragment.byteLength);
		bytes.set(complete);
		bytes.set(fragment, complete.byteLength);

		const report = inspectSessionIntegrity(bytes);
		expect(report.ok).toBe(false);
		expect(reasons(report)).toContain("trailing_fragment");
		expect(report.entries.map((value) => value.id)).toEqual(["u"]);
		expect(report.activeLeafId).toBe("u");
		expect(report.completePrefix.byteCount).toBe(complete.byteLength);
		expect(report.trailingFragment).toEqual({
			byteCount: fragment.byteLength,
			sha256: createHash("sha256").update(fragment).digest("hex"),
		});
	});

	it("never parses a newline-free header as complete", () => {
		const report = inspectSessionIntegrity(encoder.encode(JSON.stringify(header)));
		expect(report.header).toBeNull();
		expect(report.entries).toEqual([]);
		expect(reasons(report)).toEqual(expect.arrayContaining(["trailing_fragment", "missing_header"]));
	});

	it("rejects malformed interior lines without hiding later complete entries", () => {
		const bytes = encoder.encode(`${JSON.stringify(header)}\n{not-json}\n${JSON.stringify(entry("u", null))}\n`);
		const report = inspectSessionIntegrity(bytes);
		expect(report.ok).toBe(false);
		expect(report.findings).toContainEqual(expect.objectContaining({ reason: "malformed_json", line: 2 }));
		expect(report.entries.map((value) => value.id)).toEqual(["u"]);
		expect(report.transcript).toBeNull();
	});

	it("requires one supported header on the first line", () => {
		const missing = inspectSessionIntegrity(jsonl([entry("u", null)]));
		expect(reasons(missing)).toContain("missing_header");

		const unsupported = inspectSessionIntegrity(jsonl([{ ...header, version: 2 }]));
		expect(reasons(unsupported)).toContain("unsupported_header");

		const multiple = inspectSessionIntegrity(jsonl([header, header]));
		expect(reasons(multiple)).toEqual(expect.arrayContaining(["multiple_header", "late_header"]));

		const late = inspectSessionIntegrity(jsonl([entry("u", null), header]));
		expect(reasons(late)).toEqual(expect.arrayContaining(["missing_header", "late_header"]));
	});

	it("rejects duplicate IDs and missing parents", () => {
		const report = inspectSessionIntegrity(
			jsonl([header, entry("same", null), entry("same", null), entry("orphan", "missing")]),
		);
		expect(reasons(report)).toEqual(expect.arrayContaining(["duplicate_entry_id", "missing_parent"]));
		expect(report.transcript).toBeNull();
	});

	it("rejects self and multi-node parent cycles without traversing forever", () => {
		const report = inspectSessionIntegrity(jsonl([header, entry("self", "self"), entry("a", "b"), entry("b", "a")]));
		expect(reasons(report)).toEqual(expect.arrayContaining(["self_cycle", "parent_cycle"]));
		expect(report.findings.find((finding) => finding.reason === "parent_cycle")?.cycleEntryIds).toEqual(["a", "b"]);
	});

	it("inspects only the selected active branch", () => {
		const bytes = jsonl([
			header,
			entry("root", null, user("root")),
			entry("branch-a-call", "root", assistant("shared-id")),
			entry("branch-b-call", "root", assistant("shared-id")),
			entry("branch-b-result", "branch-b-call", toolResult("shared-id")),
		]);

		const cleanBranch = inspectSessionIntegrity(bytes, { activeLeafId: "branch-b-result" });
		expect(cleanBranch.ok).toBe(true);
		expect(cleanBranch.activeBranch.map((value) => value.id)).toEqual(["root", "branch-b-call", "branch-b-result"]);
		expect(cleanBranch.transcript).toEqual({ ok: true, issues: [] });

		const openBranch = inspectSessionIntegrity(bytes, { activeLeafId: "branch-a-call" });
		expect(reasons(openBranch)).toContain("transcript_missing_result");
		expect(reasons(openBranch)).not.toContain("transcript_duplicate_call_id");
	});

	it("requires every active-branch compaction to keep an earlier ancestor", () => {
		const valid = inspectSessionIntegrity(
			jsonl([header, entry("root", null), compactionEntry("compact", "root", "root")]),
		);
		expect(valid.ok).toBe(true);

		const invalid = inspectSessionIntegrity(
			jsonl([
				header,
				entry("root", null),
				compactionEntry("bad-compact", "root", "later"),
				entry("later", "bad-compact"),
				compactionEntry("good-compact", "later", "root"),
			]),
		);
		expect(invalid.findings).toContainEqual({
			reason: "compaction_first_kept_not_ancestor",
			entryId: "bad-compact",
		});
		expect(invalid.activeMessages).toEqual([]);
		expect(invalid.transcript).toBeNull();
	});

	it("rejects compaction references to the same entry or another branch", () => {
		const sameEntry = inspectSessionIntegrity(
			jsonl([header, entry("root", null), compactionEntry("compact", "root", "compact")]),
		);
		expect(reasons(sameEntry)).toContain("compaction_first_kept_not_ancestor");

		const otherBranch = inspectSessionIntegrity(
			jsonl([header, entry("root", null), entry("sibling", "root"), compactionEntry("compact", "root", "sibling")]),
		);
		expect(reasons(otherBranch)).toContain("compaction_first_kept_not_ancestor");
		expect(otherBranch.transcript).toBeNull();
	});

	it("fails closed when the selected leaf is absent", () => {
		const report = inspectSessionIntegrity(jsonl([header, entry("u", null)]), {
			activeLeafId: "missing",
		});
		expect(reasons(report)).toContain("active_leaf_missing");
		expect(report.activeMessages).toEqual([]);
		expect(report.transcript).toBeNull();
	});

	it("rejects malformed message entries before transcript inspection", () => {
		const report = inspectSessionIntegrity(
			jsonl([
				header,
				entry("bad", null, {
					role: "assistant",
					content: "not-an-array",
				}),
			]),
		);
		expect(reasons(report)).toContain("invalid_entry");
		expect(report.transcript).toBeNull();
	});

	it("supports an explicitly empty active branch", () => {
		const report = inspectSessionIntegrity(jsonl([header, entry("u", null)]), { activeLeafId: null });
		expect(report.ok).toBe(true);
		expect(report.activeLeafId).toBeNull();
		expect(report.activeBranch).toEqual([]);
		expect(report.transcript).toEqual({ ok: true, issues: [] });
	});
});
