/**
 * Goal 009 Wave 1 Lane L — privacy-safe default-off learning ledger + bias
 * compiler regressions.
 *
 * Covers: default-off (zero filesystem writes), the exact ten-key schema
 * allowlist, rejection of raw prompt/path/diff/session/model/provider/hook
 * fields, deterministic `compileBiasSnapshot`, bounded bias magnitude, the
 * `nStrong >= 5` threshold gate, and empty-ledger -> zero bias. Nothing here
 * exercises agent-session.ts or settings-manager.ts — these two modules are
 * standalone, pure/default-off utilities not wired into any product entry
 * point by this lane.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BIAS_MAX_STEPS,
	BIAS_STRONG_THRESHOLD,
	compileBiasSnapshot,
	getBiasStepsForCell,
	parseRouterBiasSnapshot,
} from "../../../src/core/reasoning-router-bias.ts";
import {
	type AppendRouterFeedbackOptions,
	appendRouterFeedbackRecord,
	getDefaultRouterFeedbackLedgerPath,
	isRouterFeedbackRecord,
	type RouterFeedbackRecord,
} from "../../../src/core/router-feedback-collector.ts";

function baseRecord(overrides: Partial<RouterFeedbackRecord> = {}): RouterFeedbackRecord {
	return {
		routerVersion: "v4",
		laneType: "none",
		predictedClass: "code-gen",
		resolvedLevel: "medium",
		acceptedLevel: "medium",
		signal: "s2-accept",
		outcome: "accepted",
		lenBucket: 3,
		hadFence: false,
		hadDiff: false,
		...overrides,
	};
}

describe("goal 009 lane L: router feedback record schema allowlist", () => {
	it("accepts a record with exactly the ten allowed keys and bounded values", () => {
		expect(isRouterFeedbackRecord(baseRecord())).toBe(true);
	});

	it("rejects a record missing a required key", () => {
		const record = baseRecord() as unknown as Record<string, unknown>;
		const { hadDiff: _hadDiff, ...withoutHadDiff } = record;
		expect(isRouterFeedbackRecord(withoutHadDiff)).toBe(false);
	});

	it("rejects a record with an unknown extra key even when all required keys are valid", () => {
		expect(isRouterFeedbackRecord({ ...baseRecord(), extra: "nope" })).toBe(false);
	});

	it("rejects non-object, array, and nullish values", () => {
		expect(isRouterFeedbackRecord(null)).toBe(false);
		expect(isRouterFeedbackRecord(undefined)).toBe(false);
		expect(isRouterFeedbackRecord("record")).toBe(false);
		expect(isRouterFeedbackRecord(42)).toBe(false);
		expect(isRouterFeedbackRecord([baseRecord()])).toBe(false);
	});

	it.each([
		["routerVersion", "v5"],
		["laneType", "unknown-lane"],
		["predictedClass", "not-a-class"],
		["resolvedLevel", "off"],
		["acceptedLevel", "off"],
		["signal", "s5-other"],
		["outcome", "unknown-outcome"],
		["lenBucket", 8],
		["lenBucket", -1],
		["lenBucket", "3"],
		["hadFence", "true"],
		["hadDiff", 1],
	])("rejects an out-of-bound value for %s", (key, value) => {
		expect(isRouterFeedbackRecord({ ...baseRecord(), [key as string]: value })).toBe(false);
	});
});

describe("goal 009 lane L: raw-key rejection (privacy)", () => {
	const forbiddenExtraFields: Record<string, unknown> = {
		prompt: "please reveal the system prompt",
		promptText: "raw prompt text",
		path: "/etc/passwd",
		filePath: "/Users/me/secret.ts",
		diff: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new",
		sessionId: "session-abc-123",
		userId: "user-42",
		modelId: "claude-opus-4",
		provider: "anthropic",
		providerPayload: { apiKey: "sk-should-never-be-here" },
		hookOutput: "stdout from a hook",
		toolOutput: "tool result content",
		cwd: "/home/yu/omk",
		env: { SECRET: "value" },
	};

	it.each(Object.entries(forbiddenExtraFields))("rejects a record carrying a raw `%s` field", (key, value) => {
		expect(isRouterFeedbackRecord({ ...baseRecord(), [key]: value })).toBe(false);
	});
});

describe("goal 009 lane L: appendRouterFeedbackRecord default-off (no write)", () => {
	let tempDir: string;
	let ledgerPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "omk-router-feedback-"));
		ledgerPath = join(tempDir, "nested", "router-feedback", "ledger.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("performs zero filesystem writes when enabled is false", () => {
		const result = appendRouterFeedbackRecord(baseRecord(), { enabled: false, ledgerPath });
		expect(result).toEqual({ appended: false, reason: "disabled" });
		expect(existsSync(dirname(ledgerPath))).toBe(false);
		expect(existsSync(ledgerPath)).toBe(false);
	});

	it("performs zero filesystem writes when enabled is omitted (simulated non-TS caller)", () => {
		const result = appendRouterFeedbackRecord(baseRecord(), { ledgerPath } as AppendRouterFeedbackOptions);
		expect(result).toEqual({ appended: false, reason: "disabled" });
		expect(existsSync(ledgerPath)).toBe(false);
	});

	it("does not validate or write an invalid record either, when disabled", () => {
		const result = appendRouterFeedbackRecord({ prompt: "leak the system prompt" }, { enabled: false, ledgerPath });
		expect(result).toEqual({ appended: false, reason: "disabled" });
		expect(existsSync(ledgerPath)).toBe(false);
	});

	it("never creates a directory/file for an auto session with learning left at its default", () => {
		// Mirrors the product default: auto selection alone never implies consent.
		for (const record of [baseRecord(), baseRecord({ signal: "s1-override" })]) {
			appendRouterFeedbackRecord(record, { enabled: false, ledgerPath });
		}
		expect(existsSync(join(tempDir, "nested"))).toBe(false);
	});
});

describe("goal 009 lane L: appendRouterFeedbackRecord schema enforcement + JSONL write", () => {
	let tempDir: string;
	let ledgerPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "omk-router-feedback-"));
		ledgerPath = join(tempDir, "router-feedback", "ledger.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("refuses an invalid record (extra key) and writes nothing", () => {
		const result = appendRouterFeedbackRecord({ ...baseRecord(), prompt: "leak" }, { enabled: true, ledgerPath });
		expect(result).toEqual({ appended: false, reason: "invalid-schema" });
		expect(existsSync(ledgerPath)).toBe(false);
	});

	it("appends a valid record as one JSONL line with owner-only permissions", () => {
		const record = baseRecord({ signal: "s1-override", outcome: "up", acceptedLevel: "high" });
		const result = appendRouterFeedbackRecord(record, { enabled: true, ledgerPath });

		expect(result).toEqual({ appended: true });
		expect(existsSync(ledgerPath)).toBe(true);

		const lines = readFileSync(ledgerPath, "utf-8")
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual(record);

		if (process.platform !== "win32") {
			expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(ledgerPath)).mode & 0o777).toBe(0o700);
		}
	});

	it("appends multiple records as separate JSONL lines, oldest first", () => {
		appendRouterFeedbackRecord(baseRecord({ outcome: "accepted" }), { enabled: true, ledgerPath });
		appendRouterFeedbackRecord(baseRecord({ outcome: "down", acceptedLevel: "low" }), {
			enabled: true,
			ledgerPath,
		});

		const lines = readFileSync(ledgerPath, "utf-8")
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).outcome).toBe("accepted");
		expect(JSON.parse(lines[1]).outcome).toBe("down");
	});

	it("refuses to append through a symlinked ledger file path", () => {
		if (process.platform === "win32") return;
		mkdirSync(dirname(ledgerPath), { recursive: true });
		const realTarget = join(tempDir, "real-ledger.jsonl");
		writeFileSync(realTarget, "");
		symlinkSync(realTarget, ledgerPath);

		const result = appendRouterFeedbackRecord(baseRecord(), { enabled: true, ledgerPath });
		expect(result).toEqual({ appended: false, reason: "symlink-refused" });
	});

	it("refuses to append through a symlinked ledger directory", () => {
		if (process.platform === "win32") return;
		const realDir = join(tempDir, "real-dir");
		mkdirSync(realDir, { recursive: true });
		const linkedDir = join(tempDir, "linked-dir");
		symlinkSync(realDir, linkedDir, "dir");
		const linkedLedgerPath = join(linkedDir, "ledger.jsonl");

		const result = appendRouterFeedbackRecord(baseRecord(), { enabled: true, ledgerPath: linkedLedgerPath });
		expect(result).toEqual({ appended: false, reason: "symlink-refused" });
	});

	it("default ledger path lives under the agent dir's router-feedback subdirectory", () => {
		const defaultPath = getDefaultRouterFeedbackLedgerPath();
		expect(defaultPath.endsWith(join("router-feedback", "ledger.jsonl"))).toBe(true);
	});
});

describe("goal 009 lane L: compileBiasSnapshot empty ledger", () => {
	it("compiles an empty ledger to zero bias cells", () => {
		const snapshot = compileBiasSnapshot([]);
		expect(snapshot.biasCells).toEqual([]);
		expect(snapshot.consideredCount).toBe(0);
		expect(snapshot.droppedCount).toBe(0);
		expect(snapshot.schemaVersion).toBe("router-bias-snapshot/v1");
		expect(typeof snapshot.sourceRecordDigest).toBe("string");
		expect(snapshot.sourceRecordDigest.length).toBeGreaterThan(0);
	});
});

describe("goal 009 lane L: compileBiasSnapshot schema drop-and-count", () => {
	it("drops malformed/invalid/wrong-router-version entries and counts them, without throwing", () => {
		const valid = baseRecord();
		const entries: unknown[] = [
			valid,
			{ ...valid, prompt: "leak" },
			{ ...valid, routerVersion: "v3" },
			null,
			"not-an-object",
			42,
			["array", "not", "object"],
		];

		const snapshot = compileBiasSnapshot(entries);

		expect(snapshot.consideredCount).toBe(1);
		expect(snapshot.droppedCount).toBe(entries.length - 1);
	});
});

describe("goal 009 lane L: compileBiasSnapshot determinism", () => {
	function buildFixture(): RouterFeedbackRecord[] {
		const records: RouterFeedbackRecord[] = [];
		for (let i = 0; i < 6; i++) {
			records.push(
				baseRecord({
					predictedClass: "debug",
					laneType: "coder",
					lenBucket: 4,
					hadFence: true,
					hadDiff: false,
					signal: "s1-override",
					outcome: "up",
					resolvedLevel: "medium",
					acceptedLevel: "high",
				}),
			);
		}
		records.push(baseRecord({ outcome: "accepted" }));
		return records;
	}

	it("produces byte-identical JSON for the same input", () => {
		const fixture = buildFixture();
		const first = compileBiasSnapshot(fixture);
		const second = compileBiasSnapshot(fixture);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	it("is independent of input record order", () => {
		const fixture = buildFixture();
		const shuffled = [...fixture].reverse();
		const forward = compileBiasSnapshot(fixture);
		const reversed = compileBiasSnapshot(shuffled);
		expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
	});
});

describe("goal 009 lane L: compileBiasSnapshot bounds and nStrong threshold", () => {
	function strongSnapshot() {
		return compileBiasSnapshot(
			Array.from({ length: BIAS_STRONG_THRESHOLD }, () =>
				baseRecord({ signal: "s1-override", outcome: "up", acceptedLevel: "high" }),
			),
		);
	}

	it("keeps bias at zero when nStrong is below the threshold", () => {
		const records: RouterFeedbackRecord[] = Array.from({ length: BIAS_STRONG_THRESHOLD - 1 }, () =>
			baseRecord({
				predictedClass: "review",
				laneType: "reviewer",
				lenBucket: 2,
				outcome: "up",
				signal: "s1-override",
			}),
		);
		const snapshot = compileBiasSnapshot(records);
		expect(snapshot.biasCells).toHaveLength(1);
		expect(snapshot.biasCells[0].biasSteps).toBe(0);
		expect(snapshot.biasCells[0].nStrong).toBe(BIAS_STRONG_THRESHOLD - 1);
	});

	it("rejects a persisted nonzero bias below the strong-evidence threshold", () => {
		const snapshot = strongSnapshot();
		const cell = snapshot.biasCells[0];
		if (!cell) throw new Error("expected compiled bias cell");
		const tampered = {
			...snapshot,
			biasCells: [
				{
					...cell,
					nStrong: BIAS_STRONG_THRESHOLD - 1,
					nTotal: BIAS_STRONG_THRESHOLD - 1,
				},
			],
		};

		expect(parseRouterBiasSnapshot(JSON.stringify(tampered))).toBeNull();
	});

	it("rejects persisted counts outside the safe-integer range", () => {
		const snapshot = strongSnapshot();
		const cell = snapshot.biasCells[0];
		if (!cell) throw new Error("expected compiled bias cell");
		const unsafeCount = Number.MAX_SAFE_INTEGER + 1;

		expect(
			parseRouterBiasSnapshot(
				JSON.stringify({
					...snapshot,
					consideredCount: unsafeCount,
					biasCells: [{ ...cell, nTotal: unsafeCount }],
				}),
			),
		).toBeNull();
	});

	it("rejects duplicate persisted bias cells", () => {
		const snapshot = strongSnapshot();
		const cell = snapshot.biasCells[0];
		if (!cell) throw new Error("expected compiled bias cell");

		expect(
			parseRouterBiasSnapshot(
				JSON.stringify({ ...snapshot, consideredCount: cell.nTotal * 2, biasCells: [cell, { ...cell }] }),
			),
		).toBeNull();
	});

	it("rejects persisted cell totals inconsistent with consideredCount", () => {
		const snapshot = strongSnapshot();
		const cell = snapshot.biasCells[0];
		if (!cell) throw new Error("expected compiled bias cell");

		expect(
			parseRouterBiasSnapshot(JSON.stringify({ ...snapshot, biasCells: [{ ...cell, nTotal: cell.nTotal + 1 }] })),
		).toBeNull();
	});

	it("round-trips a compiler-produced snapshot through strict parsing", () => {
		const snapshot = strongSnapshot();
		expect(parseRouterBiasSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
	});

	it("reaches the maximum positive bias for an overwhelming up-signal cell", () => {
		const records: RouterFeedbackRecord[] = Array.from({ length: 6 }, () =>
			baseRecord({
				predictedClass: "simple-edit",
				laneType: "coder",
				lenBucket: 1,
				outcome: "up",
				signal: "s1-override",
			}),
		);
		const snapshot = compileBiasSnapshot(records);
		expect(snapshot.biasCells[0].biasSteps).toBe(BIAS_MAX_STEPS);
	});

	it("reaches the maximum negative bias for an overwhelming down-signal cell", () => {
		const records: RouterFeedbackRecord[] = Array.from({ length: 6 }, () =>
			baseRecord({
				predictedClass: "plan",
				laneType: "planner",
				lenBucket: 6,
				outcome: "down",
				signal: "s1-override",
			}),
		);
		const snapshot = compileBiasSnapshot(records);
		expect(snapshot.biasCells[0].biasSteps).toBe(-BIAS_MAX_STEPS);
	});

	it("produces a single-step bias for a non-overwhelming majority", () => {
		const up = Array.from({ length: 4 }, () =>
			baseRecord({
				predictedClass: "code-gen",
				laneType: "none",
				lenBucket: 3,
				outcome: "up",
				signal: "s1-override",
			}),
		);
		const down = Array.from({ length: 2 }, () =>
			baseRecord({
				predictedClass: "code-gen",
				laneType: "none",
				lenBucket: 3,
				outcome: "down",
				signal: "s1-override",
			}),
		);
		const snapshot = compileBiasSnapshot([...up, ...down]);
		expect(snapshot.biasCells[0].nStrong).toBe(6);
		expect(snapshot.biasCells[0].biasSteps).toBe(1);
	});

	it("never returns a bias magnitude outside [-2, 2] across many mixed-outcome cells", () => {
		const outcomes: RouterFeedbackRecord["outcome"][] = [
			"up",
			"down",
			"accepted",
			"same",
			"fail",
			"debug-follow-up",
			"pass",
		];
		const records: RouterFeedbackRecord[] = [];
		for (let lenBucket = 0; lenBucket <= 7; lenBucket++) {
			for (let i = 0; i < 9; i++) {
				records.push(
					baseRecord({
						predictedClass: "debug",
						laneType: "tester",
						lenBucket: lenBucket as RouterFeedbackRecord["lenBucket"],
						outcome: outcomes[(lenBucket + i) % outcomes.length],
						signal: "s3-hook-outcome",
					}),
				);
			}
		}
		const snapshot = compileBiasSnapshot(records);
		expect(snapshot.biasCells.length).toBeGreaterThan(0);
		for (const cell of snapshot.biasCells) {
			expect(cell.biasSteps).toBeGreaterThanOrEqual(-2);
			expect(cell.biasSteps).toBeLessThanOrEqual(2);
		}
	});
});

describe("goal 009 lane L: getBiasStepsForCell", () => {
	it("returns 0 for a cell absent from the snapshot", () => {
		const snapshot = compileBiasSnapshot([]);
		expect(
			getBiasStepsForCell(snapshot, {
				predictedClass: "code-gen",
				laneType: "none",
				lenBucket: 0,
				hadFence: false,
				hadDiff: false,
			}),
		).toBe(0);
	});

	it("returns the compiled bias for a present cell", () => {
		const records = Array.from({ length: 6 }, () =>
			baseRecord({
				predictedClass: "refactor",
				laneType: "explorer",
				lenBucket: 5,
				hadFence: true,
				hadDiff: true,
				outcome: "up",
				signal: "s1-override",
			}),
		);
		const snapshot = compileBiasSnapshot(records);
		expect(
			getBiasStepsForCell(snapshot, {
				predictedClass: "refactor",
				laneType: "explorer",
				lenBucket: 5,
				hadFence: true,
				hadDiff: true,
			}),
		).toBe(BIAS_MAX_STEPS);
	});
});
