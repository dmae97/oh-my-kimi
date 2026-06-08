import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput } from "@oh-my-pi/pi-coding-agent/task/executor";
import { subprocessToolRegistry } from "@oh-my-pi/pi-coding-agent/task/subprocess-tool-registry";
import { parseReportFindingDetails, toReviewFinding } from "@oh-my-pi/pi-coding-agent/tools/review";

describe("report_finding subprocess extraction", () => {
	it("returns undefined for malformed finding details", () => {
		expect(parseReportFindingDetails({})).toBeUndefined();
		expect(
			parseReportFindingDetails({
				title: "[P1] Missing file path",
				body: "Body",
				priority: "P1",
				confidence: 0.8,
				line_start: 12,
				line_end: 12,
			}),
		).toBeUndefined();
	});

	it("ignores error events and extracts valid details", () => {
		const handler = subprocessToolRegistry.getHandler("report_finding");
		if (!handler?.extractData) {
			throw new Error("report_finding handler is not registered");
		}

		const validDetails = {
			title: "[P1] Example finding",
			body: "Details",
			priority: "P1" as const,
			confidence: 0.95,
			file_path: "/tmp/example.ts",
			line_start: 10,
			line_end: 12,
		};

		expect(
			handler.extractData({
				toolName: "report_finding",
				toolCallId: "call-1",
				result: {
					content: [{ type: "text", text: "Finding recorded" }],
					details: validDetails,
				},
				isError: false,
			}),
		).toEqual(validDetails);

		expect(
			handler.extractData({
				toolName: "report_finding",
				toolCallId: "call-2",
				result: {
					content: [{ type: "text", text: "Validation failed" }],
					details: {},
				},
				isError: true,
			}),
		).toBeUndefined();
	});
});

describe("toReviewFinding", () => {
	const base = {
		title: "[P0] Example finding",
		body: "Details",
		confidence: 0.95,
		file_path: "/tmp/example.ts",
		line_start: 10,
		line_end: 12,
	} as const;

	it("maps the priority string enum to its numeric ordinal", () => {
		expect(toReviewFinding({ ...base, priority: "P0" }).priority).toBe(0);
		expect(toReviewFinding({ ...base, priority: "P1" }).priority).toBe(1);
		expect(toReviewFinding({ ...base, priority: "P2" }).priority).toBe(2);
		expect(toReviewFinding({ ...base, priority: "P3" }).priority).toBe(3);
	});

	it("passes JTD validation against the reviewer agent's numeric priority schema (#1350)", () => {
		// Mirrors the bundled reviewer agent's output schema. Before the fix the
		// string priority from `report_finding` short-circuited every successful
		// review run with `findings.0.priority: expected number, received string`.
		const reviewerSchema = {
			properties: {
				overall_correctness: { enum: ["correct", "incorrect"] },
				explanation: { type: "string" },
				confidence: { type: "number" },
			},
			optionalProperties: {
				findings: {
					elements: {
						properties: {
							title: { type: "string" },
							body: { type: "string" },
							priority: { type: "number" },
							confidence: { type: "number" },
							file_path: { type: "string" },
							line_start: { type: "number" },
							line_end: { type: "number" },
						},
					},
				},
			},
		};

		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [
				{
					status: "success",
					data: {
						overall_correctness: "incorrect",
						explanation: "Found one bug",
						confidence: 0.9,
					},
				},
			],
			reportFindings: [toReviewFinding({ ...base, priority: "P2" })],
			outputSchema: reviewerSchema,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.rawOutput) as {
			findings: Array<{ priority: number }>;
		};
		expect(parsed.findings[0].priority).toBe(2);
	});
});

describe("findings injection respects active output schema", () => {
	const finding = toReviewFinding({
		title: "[P0] Example finding",
		body: "Details",
		priority: "P0",
		confidence: 0.95,
		file_path: "/tmp/example.ts",
		line_start: 10,
		line_end: 12,
	});

	// Reproduces #2070: a caller-supplied JSON Schema with
	// `additionalProperties: false` and no `findings` property is silently
	// rejected post-mortem after the in-tool yield accepted it, because the
	// executor auto-injects `findings` from `report_finding`. The injection
	// must respect the active schema so that "accepted in-tool ⇒ accepted
	// post-mortem" is honored.
	it("suppresses findings injection when the schema forbids additional properties", () => {
		const callerSchema = {
			type: "object",
			additionalProperties: false,
			required: ["verdict", "acceptance_summary"],
			properties: {
				verdict: { enum: ["accept", "needs-work", "honest-stop"] },
				acceptance_summary: { type: "string" },
			},
		};
		const data = { verdict: "accept", acceptance_summary: "All good." };

		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data }],
			reportFindings: [finding],
			outputSchema: callerSchema,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.rawOutput) as Record<string, unknown>;
		expect(parsed).toEqual(data);
		expect("findings" in parsed).toBe(false);
	});

	it("still injects findings when the schema declares them (bundled reviewer JTD)", () => {
		// Mirrors the bundled reviewer agent's output: findings live under
		// `optionalProperties`, so injection must continue to flow through.
		const reviewerSchema = {
			properties: {
				overall_correctness: { enum: ["correct", "incorrect"] },
				explanation: { type: "string" },
				confidence: { type: "number" },
			},
			optionalProperties: {
				findings: {
					elements: {
						properties: {
							title: { type: "string" },
							body: { type: "string" },
							priority: { type: "number" },
							confidence: { type: "number" },
							file_path: { type: "string" },
							line_start: { type: "number" },
							line_end: { type: "number" },
						},
					},
				},
			},
		};
		const data = {
			overall_correctness: "incorrect",
			explanation: "Found one bug",
			confidence: 0.9,
		};

		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data }],
			reportFindings: [finding],
			outputSchema: reviewerSchema,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.rawOutput) as { findings: Array<{ priority: number }> };
		expect(parsed.findings).toHaveLength(1);
		expect(parsed.findings[0].priority).toBe(0);
	});

	it("still injects findings when no schema is declared (legacy free-form)", () => {
		const data = { note: "freeform" };

		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data }],
			reportFindings: [finding],
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.rawOutput) as { findings?: unknown[] };
		expect(parsed.findings).toHaveLength(1);
	});

	it("still injects findings when additionalProperties is open", () => {
		const openSchema = {
			type: "object",
			required: ["verdict"],
			properties: { verdict: { type: "string" } },
		};
		const data = { verdict: "accept" };

		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data }],
			reportFindings: [finding],
			outputSchema: openSchema,
		});

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.rawOutput) as { findings?: unknown[]; verdict: string };
		expect(parsed.verdict).toBe("accept");
		expect(parsed.findings).toHaveLength(1);
	});

	it("suppresses injection on the fallback (no-yield) path when the schema forbids it", () => {
		const callerSchema = {
			type: "object",
			additionalProperties: false,
			required: ["verdict"],
			properties: { verdict: { type: "string" } },
		};
		const rawJson = JSON.stringify({ data: { verdict: "accept" } });

		const result = finalizeSubprocessOutput({
			rawOutput: rawJson,
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			reportFindings: [finding],
			outputSchema: callerSchema,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.rawOutput) as Record<string, unknown>;
		expect(parsed).toEqual({ verdict: "accept" });
	});
});
