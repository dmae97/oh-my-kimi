import { describe, expect, it, vi } from "vitest";
import * as currentAgentCore from "../../agent/src/index.ts";
import { inspectSessionIntegrity } from "../src/core/session-integrity.ts";
import { createSessionRepairPlan } from "../src/core/session-repair-plan.ts";

vi.mock("omk-agent-core", () => currentAgentCore);

const encoder = new TextEncoder();
const header = {
	type: "session",
	version: 3,
	id: "session-1",
	timestamp: "2026-07-15T00:00:00.000Z",
	cwd: "/workspace",
};
const options = { repairId: "repair-1", reason: "doctor_repair" as const, timestamp: 123 };

function assistant(calls: readonly string[]) {
	return {
		role: "assistant",
		content: calls.map((id) => ({ type: "toolCall", id, name: `tool-${id}`, arguments: {} })),
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
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function result(toolCallId: string) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: `tool-${toolCallId}`,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 1,
	};
}

function entry(id: string, parentId: string | null, message: unknown) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-15T00:00:00.000Z",
		message,
	};
}

function jsonl(records: readonly unknown[]): Uint8Array {
	return encoder.encode(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

describe("createSessionRepairPlan", () => {
	it("returns an immutable no-op plan for a clean session", () => {
		const report = inspectSessionIntegrity(jsonl([header]));
		const plan = createSessionRepairPlan(report, options);
		expect(plan.status).toBe("not_needed");
		expect(plan.actions).toEqual([]);
		expect(plan.blockers).toEqual([]);
		expect(plan.precondition.completePrefix).toEqual(report.completePrefix);
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.actions)).toBe(true);
	});

	it("plans quarantine before deterministic missing-tail closure", () => {
		const complete = jsonl([header, entry("call", null, assistant(["a", "b"]))]);
		const fragment = encoder.encode('{"type":"message"');
		const bytes = new Uint8Array(complete.byteLength + fragment.byteLength);
		bytes.set(complete);
		bytes.set(fragment, complete.byteLength);
		const report = inspectSessionIntegrity(bytes);
		const before = JSON.stringify(report);

		const plan = createSessionRepairPlan(report, options);
		expect(plan.status).toBe("repairable");
		expect(plan.actions.map((action) => action.kind)).toEqual([
			"quarantine_trailing_fragment",
			"append_synthetic_tool_result",
			"append_synthetic_tool_result",
		]);
		expect(plan.precondition).toMatchObject({
			source: report.source,
			completePrefix: report.completePrefix,
			activeLeafId: "call",
		});
		const appendActions = plan.actions.filter((action) => action.kind === "append_synthetic_tool_result");
		expect(appendActions.map((action) => action.toolCallId)).toEqual(["a", "b"]);
		expect(appendActions.map((action) => action.sequence)).toEqual([0, 1]);
		expect(appendActions[0]?.message).toMatchObject({
			role: "toolResult",
			toolCallId: "a",
			toolName: "tool-a",
			isError: true,
			timestamp: 123,
		});
		expect(appendActions[0]?.message.content).toEqual([
			{ type: "text", text: "Tool result missing; synthesized by session doctor repair" },
		]);
		expect(Object.isFrozen(appendActions[0]?.message)).toBe(true);
		expect(Object.isFrozen(appendActions[0]?.message.content)).toBe(true);
		expect(JSON.stringify(report)).toBe(before);
	});

	it("plans only unresolved calls after existing partial results", () => {
		const report = inspectSessionIntegrity(
			jsonl([header, entry("call", null, assistant(["a", "b"])), entry("result-a", "call", result("a"))]),
		);
		const plan = createSessionRepairPlan(report, {
			...options,
			reason: "resume_recovery",
		});
		expect(plan.status).toBe("repairable");
		expect(plan.actions).toHaveLength(1);
		expect(plan.actions[0]).toMatchObject({
			kind: "append_synthetic_tool_result",
			toolCallId: "b",
			toolName: "tool-b",
		});
		if (plan.actions[0]?.kind === "append_synthetic_tool_result") {
			expect(plan.actions[0].message.content).toEqual([
				{ type: "text", text: "Tool result missing; synthesized during session resume recovery" },
			]);
		}
	});

	it("fails closed for an interleaved mid-transcript gap", () => {
		const report = inspectSessionIntegrity(
			jsonl([
				header,
				entry("call-ab", null, assistant(["a", "b"])),
				entry("result-b", "call-ab", result("b")),
				entry("call-c", "result-b", assistant(["c"])),
				entry("result-c", "call-c", result("c")),
			]),
		);
		const plan = createSessionRepairPlan(report, options);
		expect(plan.status).toBe("blocked");
		expect(plan.actions).toEqual([]);
		expect(plan.blockers).toContainEqual(
			expect.objectContaining({
				reason: "integrity_finding",
				findingReason: "transcript_interleaved_non_result",
			}),
		);
	});

	it("fails closed for duplicate, orphan, and tree corruption", () => {
		const duplicate = inspectSessionIntegrity(
			jsonl([
				header,
				entry("call", null, assistant(["a"])),
				entry("result-1", "call", result("a")),
				entry("result-2", "result-1", result("a")),
			]),
		);
		expect(createSessionRepairPlan(duplicate, options)).toMatchObject({
			status: "blocked",
			actions: [],
		});

		const orphan = inspectSessionIntegrity(jsonl([header, entry("orphan", null, result("ghost"))]));
		expect(createSessionRepairPlan(orphan, options)).toMatchObject({ status: "blocked", actions: [] });

		const cycle = inspectSessionIntegrity(
			jsonl([header, entry("a", "b", assistant([])), entry("b", "a", assistant([]))]),
		);
		expect(createSessionRepairPlan(cycle, options)).toMatchObject({ status: "blocked", actions: [] });
	});

	it("does not plan repairs for corruption on an inactive branch", () => {
		const bytes = jsonl([
			header,
			entry("open", null, assistant(["shared"])),
			entry("closed", null, assistant(["shared"])),
			entry("closed-result", "closed", result("shared")),
		]);
		const activeReport = inspectSessionIntegrity(bytes, { activeLeafId: "closed-result" });
		const plan = createSessionRepairPlan(activeReport, options);
		expect(plan.status).toBe("not_needed");
		expect(plan.actions).toEqual([]);
	});

	it("returns identical plans for identical reports and deterministic inputs", () => {
		const report = inspectSessionIntegrity(jsonl([header, entry("call", null, assistant(["a"]))]));
		expect(createSessionRepairPlan(report, options)).toEqual(createSessionRepairPlan(report, options));
	});

	it("blocks forged equal-count transcript issue identities", () => {
		const report = inspectSessionIntegrity(jsonl([header, entry("call", null, assistant(["a"]))]));
		if (!report.transcript) throw new Error("expected transcript report");
		const forged = {
			...report,
			transcript: {
				...report.transcript,
				issues: report.transcript.issues.map((issue) => ({ ...issue, toolCallId: "different" })),
			},
			findings: report.findings.map((finding) => ({ ...finding, toolCallId: "different" })),
		};
		expect(createSessionRepairPlan(forged, options)).toMatchObject({
			status: "blocked",
			blockers: [{ reason: "inconsistent_report" }],
		});
	});

	it("blocks forged transcript finding identities", () => {
		const report = inspectSessionIntegrity(jsonl([header, entry("call", null, assistant(["a"]))]));
		const forged = {
			...report,
			findings: report.findings.map((finding) => ({ ...finding, line: 99 })),
		};
		expect(createSessionRepairPlan(forged, options)).toMatchObject({
			status: "blocked",
			blockers: [{ reason: "inconsistent_report" }],
		});
	});

	it("blocks forged report and transcript ok flags", () => {
		const report = inspectSessionIntegrity(jsonl([header, entry("call", null, assistant(["a"]))]));
		const forgedReports = [
			{ ...report, ok: true },
			{ ...report, transcript: { ...report.transcript, ok: true, issues: report.transcript?.issues ?? [] } },
		];
		for (const forged of forgedReports) {
			expect(createSessionRepairPlan(forged, options)).toMatchObject({
				status: "blocked",
				blockers: [{ reason: "inconsistent_report" }],
			});
		}
	});

	it("requires exact trailing-fragment finding correspondence", () => {
		const complete = jsonl([header]);
		const fragment = encoder.encode('{"type":"message"');
		const bytes = new Uint8Array(complete.byteLength + fragment.byteLength);
		bytes.set(complete);
		bytes.set(fragment, complete.byteLength);
		const report = inspectSessionIntegrity(bytes);
		const forgedReports = [
			{ ...report, trailingFragment: null },
			{ ...report, ok: true, findings: [] },
		];
		for (const forged of forgedReports) {
			expect(createSessionRepairPlan(forged, options)).toMatchObject({
				status: "blocked",
				blockers: [{ reason: "inconsistent_report" }],
			});
		}
	});

	it("rejects unbounded repair metadata", () => {
		const report = inspectSessionIntegrity(jsonl([header]));
		expect(() => createSessionRepairPlan(report, { ...options, repairId: "bad\0id" })).toThrow("C0 or DEL");
		expect(() => createSessionRepairPlan(report, { ...options, repairId: "bad\u001fid" })).toThrow("C0 or DEL");
		expect(() => createSessionRepairPlan(report, { ...options, repairId: "bad\u007fid" })).toThrow("C0 or DEL");
		expect(() => createSessionRepairPlan(report, { ...options, reason: "raw_reason" as never })).toThrow("reason");
		expect(() => createSessionRepairPlan(report, { ...options, timestamp: -1 })).toThrow("timestamp");
	});
});
