import { describe, expect, it } from "bun:test";
import {
	finalizeSubprocessOutput,
	SUBAGENT_WARNING_MISSING_YIELD,
	SUBAGENT_WARNING_NULL_YIELD,
} from "../../src/task/executor";

describe("subagent warning injection", () => {
	it("injects null-data warning when yield is success without data", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success" }],
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe(`${SUBAGENT_WARNING_NULL_YIELD}\n\npartial output`);
		expect(result.hasYield).toBe(true);
	});

	it("injects missing-submit warning when subagent exits cleanly without yield", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { properties: { ok: { type: "boolean" } } },
		});

		expect(result.rawOutput).toBe(SUBAGENT_WARNING_MISSING_YIELD);
		expect(result.hasYield).toBe(false);
	});

	it("does not inject missing-submit warning when fallback completion is recoverable", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: '{"data":{"ok":true}}',
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe('{\n  "ok": true\n}');
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
	});

	it("prefixes missing-submit warning on stop outputs", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "agent stopped after writing analysis",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe(`${SUBAGENT_WARNING_MISSING_YIELD}\n\nagent stopped after writing analysis`);
	});

	it("does not inject missing-submit warning when execution exits non-zero", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 1,
			stderr: "subagent terminated",
			doneAborted: true,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe("");
		expect(result.stderr).toBe("subagent terminated");
		expect(result.exitCode).toBe(1);
	});

	it("normalizes explicit aborted yield into aborted payload", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 1,
			stderr: "old error",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "aborted", error: "blocked by permissions" }],
			outputSchema: undefined,
		});

		expect(result.abortedViaYield).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("blocked by permissions");
		expect(result.rawOutput).toContain('"aborted": true');
		expect(result.rawOutput).toContain('"blocked by permissions"');
	});

	it("accepts successful yield data without warning", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "should be replaced",
			exitCode: 1,
			stderr: "should clear",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { ok: true } }],
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe('{\n  "ok": true\n}');
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
	});

	it("does not inject missing-submit warning when no schema and raw text exists", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "plain text notes",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe("plain text notes");
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
		expect(result.exitCode).toBe(0);
	});
});
