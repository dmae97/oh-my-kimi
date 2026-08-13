/**
 * Regression tests for default-off and opt-in `/think auto` v4 learning-bias
 * wiring. All prompts are synthetic test data. Every snapshot/ledger path is a
 * fresh temp directory cleaned up in `afterEach`; nothing here reads or writes a
 * real agent directory.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "omk-agent-core";
import { fauxAssistantMessage } from "omk-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BIAS_STRONG_THRESHOLD,
	compileBiasSnapshot,
	parseRouterBiasSnapshot,
	type RouterBiasSnapshot,
} from "../../../src/core/reasoning-router-bias.ts";
import {
	classifyTaskV4,
	deriveRouterFeedbackFeaturesV4,
	resolveThinkingLevelV4WithUncertainty,
} from "../../../src/core/reasoning-router-v4.ts";
import { getRepositoryRouterLearningPaths } from "../../../src/core/repository-learning-scope.ts";
import { isRouterFeedbackRecord, type RouterFeedbackRecord } from "../../../src/core/router-feedback-collector.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

/** Already-verified v4 ground truth: taskClass "simple-edit", confidenceBand "high", resolves "low" at bias 0. */
const SPELLING_PROMPT = "correct the spelling of 'recieve' to 'receive'";
/** Already-verified v4 ground truth: taskClass "plan", confidenceBand "high". */
const PLAN_PROMPT = "plan the architecture roadmap for the storage layer";

const FULL_LEVEL_SET: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function readJsonlRecords(path: string): unknown[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

function writeSnapshotFile(path: string, snapshot: RouterBiasSnapshot): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(snapshot));
}

function writeRawSnapshotFile(path: string, raw: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, raw);
}

/** Builds a single-cell, unanimous-outcome bias snapshot for `prompt` via the real compiler (routerVersion "v4"). */
function buildSingleCellSnapshot(
	prompt: string,
	outcome: "up" | "down",
	count: number = BIAS_STRONG_THRESHOLD + 1,
): RouterBiasSnapshot {
	const predictedClass = classifyTaskV4({ prompt }).taskClass;
	const feedbackFeatures = deriveRouterFeedbackFeaturesV4(prompt);
	const records: RouterFeedbackRecord[] = Array.from({ length: count }, () => ({
		routerVersion: "v4",
		laneType: "none",
		predictedClass,
		resolvedLevel: "low",
		acceptedLevel: outcome === "up" ? "high" : "minimal",
		signal: "s1-override",
		outcome,
		...feedbackFeatures,
	}));
	return compileBiasSnapshot(records, { routerVersion: "v4" });
}

// ============================================================================
// Session-level harness (InteractiveMode private-method tunneling; redefined
// locally per this repo's self-containment convention for regression tests).
// ============================================================================

type SubmitEditor = { onSubmit?: (text: string) => Promise<void> | void };

type ThinkSubmitContext = {
	readonly defaultEditor: SubmitEditor;
	readonly editor: { readonly setText: (text: string) => void };
	readonly session: Harness["session"];
	readonly footer: { readonly invalidate: () => void };
	readonly handleThinkCommand: (level?: string) => void;
	readonly enableAutoThinkingMode: () => void;
	readonly applyThinkingLevel: (level: ThinkingLevel) => void;
	readonly showThinkingSelector: () => void;
	readonly showError: (message: string) => void;
	readonly showStatus: (message: string) => void;
	readonly updateEditorBorderColor: () => void;
};

type InteractiveModeThinkPrivate = {
	setupEditorSubmitHandler(this: ThinkSubmitContext): void;
	handleThinkCommand(this: ThinkSubmitContext, level?: string): void;
	enableAutoThinkingMode(this: ThinkSubmitContext): void;
	applyThinkingLevel(this: ThinkSubmitContext, level: ThinkingLevel): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModeThinkPrivate;

const harnesses: Harness[] = [];
const scratchDirs: string[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	while (scratchDirs.length > 0) {
		const dir = scratchDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	vi.unstubAllEnvs();
});

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omk-014-learning-"));
	scratchDirs.push(dir);
	return dir;
}

async function createThinkSubmitContext(
	settings?: HarnessOptions["settings"],
): Promise<{ readonly harness: Harness; readonly context: ThinkSubmitContext }> {
	const harness = await createHarness({ models: [{ id: "faux-think", reasoning: true }], settings });
	harnesses.push(harness);

	const context: ThinkSubmitContext = {
		defaultEditor: {},
		editor: { setText: vi.fn() },
		session: harness.session,
		footer: { invalidate: vi.fn() },
		handleThinkCommand(level?: string) {
			interactiveModePrototype.handleThinkCommand.call(context, level);
		},
		enableAutoThinkingMode() {
			interactiveModePrototype.enableAutoThinkingMode.call(context);
		},
		applyThinkingLevel(level: ThinkingLevel) {
			interactiveModePrototype.applyThinkingLevel.call(context, level);
		},
		showThinkingSelector: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	};

	interactiveModePrototype.setupEditorSubmitHandler.call(context);
	return { harness, context };
}

async function submit(context: ThinkSubmitContext, command: string): Promise<void> {
	const handler = context.defaultEditor.onSubmit;
	expect(handler).toBeDefined();
	await handler?.(command);
}

async function promptAndReadLevel(harness: Harness, prompt: string): Promise<ThinkingLevel | undefined> {
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt(prompt);
	return harness.session.thinkingLevel;
}

// ============================================================================
// Tests
// ============================================================================

describe("goal 010 lane T: default settings — auto behavior and ledger/snapshot I/O unchanged", () => {
	it('/think auto resolves the known simple-edit sentinel to "low" with no learning settings configured', async () => {
		const { harness, context } = await createThinkSubmitContext();

		expect(harness.settingsManager.getReasoningRouterLearningEnabled()).toBe(false);

		await submit(context, "/think auto");
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("low");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("/think auto resolves the known plan sentinel exactly as the real classifier+resolver predict with no learning settings configured", async () => {
		const { harness, context } = await createThinkSubmitContext();
		await submit(context, "/think auto");

		const availableLevels = harness.session.getAvailableThinkingLevels();
		const verdict = classifyTaskV4({ prompt: PLAN_PROMPT });
		expect(verdict.taskClass).toBe("plan");
		const expectedLevel = resolveThinkingLevelV4WithUncertainty(verdict, availableLevels, undefined, 0, null);

		expect(await promptAndReadLevel(harness, PLAN_PROMPT)).toBe(expectedLevel);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("configuring biasSnapshotPath/feedbackLedgerPath alone (without enabled: true) never creates either file", async () => {
		const dir = scratchDir();
		const biasSnapshotPath = join(dir, "snapshot.json");
		const feedbackLedgerPath = join(dir, "ledger.jsonl");

		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { biasSnapshotPath, feedbackLedgerPath },
		});
		expect(harness.settingsManager.getReasoningRouterLearningEnabled()).toBe(false);

		await submit(context, "/think auto");
		await promptAndReadLevel(harness, SPELLING_PROMPT);
		await promptAndReadLevel(harness, PLAN_PROMPT);

		expect(existsSync(biasSnapshotPath)).toBe(false);
		expect(existsSync(feedbackLedgerPath)).toBe(false);
		expect(context.showError).not.toHaveBeenCalled();
	});
});

describe("goal 010 lane T: opt-in learning, no snapshot present — same resolution, one bounded ledger record per turn", () => {
	it("resolves the simple-edit sentinel identically to the default (bias 0 with no snapshot) and appends exactly one well-formed, ten-key v4 feedback record with no forbidden keys", async () => {
		const dir = scratchDir();
		const biasSnapshotPath = join(dir, "snapshot.json"); // deliberately never created: "no snapshot"
		const feedbackLedgerPath = join(dir, "ledger.jsonl");

		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true, biasSnapshotPath, feedbackLedgerPath },
		});
		expect(harness.settingsManager.getReasoningRouterLearningEnabled()).toBe(true);
		expect(existsSync(biasSnapshotPath)).toBe(false);

		await submit(context, "/think auto");
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("low");
		expect(context.showError).not.toHaveBeenCalled();

		const rawRecords = readJsonlRecords(feedbackLedgerPath);
		expect(rawRecords).toHaveLength(1);
		const [rawRecord] = rawRecords;
		expect(isRouterFeedbackRecord(rawRecord)).toBe(true);
		const record = rawRecord as RouterFeedbackRecord;

		expect(Object.keys(record).sort()).toEqual([
			"acceptedLevel",
			"hadDiff",
			"hadFence",
			"laneType",
			"lenBucket",
			"outcome",
			"predictedClass",
			"resolvedLevel",
			"routerVersion",
			"signal",
		]);
		expect(record).toEqual({
			routerVersion: "v4",
			laneType: "none",
			predictedClass: "simple-edit",
			resolvedLevel: "low",
			acceptedLevel: "low",
			signal: "s2-accept",
			outcome: "accepted",
			lenBucket: deriveRouterFeedbackFeaturesV4(SPELLING_PROMPT).lenBucket,
			hadFence: false,
			hadDiff: false,
		});
	});

	it("appends one ordered ledger line per auto turn", async () => {
		const dir = scratchDir();
		const feedbackLedgerPath = join(dir, "ledger.jsonl");
		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true, feedbackLedgerPath },
		});

		await submit(context, "/think auto");
		await promptAndReadLevel(harness, SPELLING_PROMPT);
		await promptAndReadLevel(harness, PLAN_PROMPT);

		const rawRecords = readJsonlRecords(feedbackLedgerPath);
		expect(rawRecords).toHaveLength(2);
		for (const raw of rawRecords) {
			expect(isRouterFeedbackRecord(raw)).toBe(true);
		}
		const records = rawRecords as RouterFeedbackRecord[];
		expect(records[0].predictedClass).toBe("simple-edit");
		expect(records[1].predictedClass).toBe("plan");
	});
});

describe("goal 010 lane T: opt-in learning with a valid bias snapshot — escalates/de-escalates auto resolution within bounds", () => {
	it('a unanimous up-vote snapshot escalates the simple-edit sentinel from "low" to "high" (+2 ladder rungs, the documented bias bound)', async () => {
		expect(classifyTaskV4({ prompt: SPELLING_PROMPT }).confidenceBand).toBe("high");

		const dir = scratchDir();
		const biasSnapshotPath = join(dir, "snapshot.json");
		const feedbackLedgerPath = join(dir, "ledger.jsonl");
		writeSnapshotFile(biasSnapshotPath, buildSingleCellSnapshot(SPELLING_PROMPT, "up"));

		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true, biasSnapshotPath, feedbackLedgerPath },
		});

		await submit(context, "/think auto");
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("high");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it('a unanimous down-vote snapshot de-escalates the simple-edit sentinel from "low" to "minimal" (-2 ladder rungs, clamped at the floor)', async () => {
		const dir = scratchDir();
		const biasSnapshotPath = join(dir, "snapshot.json");
		const feedbackLedgerPath = join(dir, "ledger.jsonl");
		writeSnapshotFile(biasSnapshotPath, buildSingleCellSnapshot(SPELLING_PROMPT, "down"));

		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true, biasSnapshotPath, feedbackLedgerPath },
		});

		await submit(context, "/think auto");
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("minimal");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("bias for a cell absent from the snapshot stays 0 (a snapshot compiled for a different prompt's cell never biases this one)", async () => {
		const dir = scratchDir();
		const biasSnapshotPath = join(dir, "snapshot.json");
		const feedbackLedgerPath = join(dir, "ledger.jsonl");
		// Compiled for SPELLING_PROMPT's cell only; PLAN_PROMPT's cell is absent from it.
		writeSnapshotFile(biasSnapshotPath, buildSingleCellSnapshot(SPELLING_PROMPT, "up"));

		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true, biasSnapshotPath, feedbackLedgerPath },
		});
		await submit(context, "/think auto");

		const availableLevels = harness.session.getAvailableThinkingLevels();
		const verdict = classifyTaskV4({ prompt: PLAN_PROMPT });
		const expectedUnbiasedLevel = resolveThinkingLevelV4WithUncertainty(verdict, availableLevels, undefined, 0, null);

		expect(await promptAndReadLevel(harness, PLAN_PROMPT)).toBe(expectedUnbiasedLevel);
	});
});

describe("goal 010 lane T: bias snapshots and misses stay pinned within a session", () => {
	it("does not reload a snapshot after the first learning-enabled auto turn", async () => {
		const dir = scratchDir();
		const biasSnapshotPath = join(dir, "snapshot.json");
		const feedbackLedgerPath = join(dir, "ledger.jsonl");
		writeSnapshotFile(biasSnapshotPath, buildSingleCellSnapshot(SPELLING_PROMPT, "up"));
		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true, biasSnapshotPath, feedbackLedgerPath },
		});
		await submit(context, "/think auto");
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("high");

		writeSnapshotFile(biasSnapshotPath, buildSingleCellSnapshot(SPELLING_PROMPT, "down"));
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("high");
	});

	it("does not load a snapshot created after the session pinned a miss", async () => {
		const dir = scratchDir();
		const biasSnapshotPath = join(dir, "snapshot.json");
		const feedbackLedgerPath = join(dir, "ledger.jsonl");
		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true, biasSnapshotPath, feedbackLedgerPath },
		});
		await submit(context, "/think auto");
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("low");

		writeSnapshotFile(biasSnapshotPath, buildSingleCellSnapshot(SPELLING_PROMPT, "up"));
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("low");
	});
});

describe("goal 010 lane T: opt-in learning with an invalid or corrupted on-disk snapshot — ignored, falls back to unbiased resolution (end-to-end)", () => {
	const invalidSnapshotCases: Array<[string, string]> = [
		["unparsable JSON text", "{not valid json"],
		["valid JSON, missing every required key", "{}"],
		[
			"well-formed shape but biasCells is not an array",
			JSON.stringify({
				schemaVersion: "router-bias-snapshot/v1",
				sourceRecordDigest: "a".repeat(64),
				consideredCount: 0,
				droppedCount: 0,
				biasCells: "not-an-array",
			}),
		],
		[
			"schemaVersion does not match the current snapshot schema",
			JSON.stringify({
				schemaVersion: "router-bias-snapshot/v2",
				sourceRecordDigest: "a".repeat(64),
				consideredCount: 0,
				droppedCount: 0,
				biasCells: [],
			}),
		],
		[
			"a cell carries an out-of-range biasSteps value",
			JSON.stringify({
				schemaVersion: "router-bias-snapshot/v1",
				sourceRecordDigest: "a".repeat(64),
				consideredCount: 6,
				droppedCount: 0,
				biasCells: [
					{
						predictedClass: "simple-edit",
						laneType: "none",
						lenBucket: deriveRouterFeedbackFeaturesV4(SPELLING_PROMPT).lenBucket,
						hadFence: false,
						hadDiff: false,
						biasSteps: 3,
						nStrong: 6,
						nTotal: 6,
					},
				],
			}),
		],
	];

	it.each(invalidSnapshotCases)(
		'%s: the simple-edit sentinel still resolves unbiased ("low") and a normal feedback record is still appended',
		async (_label, raw) => {
			const dir = scratchDir();
			const biasSnapshotPath = join(dir, "snapshot.json");
			const feedbackLedgerPath = join(dir, "ledger.jsonl");
			writeRawSnapshotFile(biasSnapshotPath, raw);

			const { harness, context } = await createThinkSubmitContext({
				reasoningRouterLearning: { enabled: true, biasSnapshotPath, feedbackLedgerPath },
			});

			await submit(context, "/think auto");
			expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("low");
			expect(context.showError).not.toHaveBeenCalled();

			const rawRecords = readJsonlRecords(feedbackLedgerPath);
			expect(rawRecords).toHaveLength(1);
			expect(isRouterFeedbackRecord(rawRecords[0])).toBe(true);
		},
	);
});

describe("goal 010 lane T: parseRouterBiasSnapshot rejects the same malformed snapshots directly (unit-level)", () => {
	it.each([
		["unparsable JSON text", "{not valid json"],
		["valid JSON, missing every required key", "{}"],
		[
			"well-formed shape but biasCells is not an array",
			JSON.stringify({
				schemaVersion: "router-bias-snapshot/v1",
				sourceRecordDigest: "a".repeat(64),
				consideredCount: 0,
				droppedCount: 0,
				biasCells: "not-an-array",
			}),
		],
	])("%s -> null, never throws", (_label, raw) => {
		expect(() => parseRouterBiasSnapshot(raw)).not.toThrow();
		expect(parseRouterBiasSnapshot(raw)).toBeNull();
	});

	it("a genuinely valid compiled snapshot round-trips through JSON + parseRouterBiasSnapshot unchanged", () => {
		const snapshot = buildSingleCellSnapshot(SPELLING_PROMPT, "up");
		const parsed = parseRouterBiasSnapshot(JSON.stringify(snapshot));
		expect(parsed).toEqual(snapshot);
	});
});

describe("repository-scoped default learning paths", () => {
	it("loads the current repository snapshot and appends feedback without explicit path overrides", async () => {
		// Given
		const agentDir = scratchDir();
		vi.stubEnv("OMK_CODING_AGENT_DIR", agentDir);
		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true },
		});
		const paths = getRepositoryRouterLearningPaths(harness.tempDir, agentDir);
		writeSnapshotFile(paths.biasSnapshotPath, buildSingleCellSnapshot(SPELLING_PROMPT, "up"));

		// When
		await submit(context, "/think auto");
		const level = await promptAndReadLevel(harness, SPELLING_PROMPT);

		// Then
		expect(level).toBe("high");
		expect(readJsonlRecords(paths.ledgerPath)).toHaveLength(1);
		expect(existsSync(join(agentDir, "router-feedback", "ledger.jsonl"))).toBe(false);
	});
});

describe("goal 010 lane T: manual /think low after auto still wins, even against an actively non-zero bias", () => {
	it('/think low exits auto and pins the level at "low" even though the active snapshot would otherwise escalate the same prompt to "high"', async () => {
		const dir = scratchDir();
		const biasSnapshotPath = join(dir, "snapshot.json");
		const feedbackLedgerPath = join(dir, "ledger.jsonl");
		writeSnapshotFile(biasSnapshotPath, buildSingleCellSnapshot(SPELLING_PROMPT, "up"));

		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true, biasSnapshotPath, feedbackLedgerPath },
		});

		await submit(context, "/think auto");
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("high"); // bias is genuinely active here

		await submit(context, "/think low");
		expect(harness.session.thinkingMode).toBe("manual");

		const records = readJsonlRecords(feedbackLedgerPath);
		expect(records).toHaveLength(2);
		expect(records[1]).toMatchObject({
			signal: "s1-override",
			predictedClass: "simple-edit",
			resolvedLevel: "high",
			acceptedLevel: "low",
			outcome: "down",
		});
		expect(isRouterFeedbackRecord(records[1])).toBe(true);

		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("low");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("routes the RPC explicit-level command through the override-aware setter", () => {
		const rpcSource = readFileSync(new URL("../../../src/modes/rpc/rpc-mode.ts", import.meta.url), "utf8");
		expect(rpcSource).toMatch(
			/case "set_thinking_level":[\s\S]*?session\.setUserThinkingLevel\(command\.level\);[\s\S]*?case /u,
		);
	});

	it.each([
		{ level: "high", outcome: "up" },
		{ level: "low", outcome: "same" },
	] satisfies readonly { readonly level: ThinkingLevel; readonly outcome: "up" | "same" }[])(
		"records an explicit $level choice as a bounded $outcome signal",
		async ({ level, outcome }) => {
			// Given
			const dir = scratchDir();
			const feedbackLedgerPath = join(dir, "ledger.jsonl");
			const { harness, context } = await createThinkSubmitContext({
				reasoningRouterLearning: { enabled: true, feedbackLedgerPath },
			});
			await submit(context, "/think auto");
			expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("low");

			// When
			await submit(context, `/think ${level}`);

			// Then
			const records = readJsonlRecords(feedbackLedgerPath);
			expect(records[1]).toMatchObject({ signal: "s1-override", acceptedLevel: level, outcome });
		},
	);

	it("records Ctrl+T cycling out of auto mode as an explicit override", async () => {
		// Given
		const dir = scratchDir();
		const feedbackLedgerPath = join(dir, "ledger.jsonl");
		const { harness, context } = await createThinkSubmitContext({
			reasoningRouterLearning: { enabled: true, feedbackLedgerPath },
		});
		await submit(context, "/think auto");
		expect(await promptAndReadLevel(harness, SPELLING_PROMPT)).toBe("low");

		// When
		const cycledLevel = harness.session.cycleThinkingLevel();

		// Then
		expect(cycledLevel).toBe("medium");
		expect(harness.session.thinkingMode).toBe("manual");
		expect(readJsonlRecords(feedbackLedgerPath)[1]).toMatchObject({
			signal: "s1-override",
			acceptedLevel: "medium",
			outcome: "up",
		});
	});
});

describe("goal 010 lane T: resolver-level bias clamp bounds (direct, defense in depth)", () => {
	it("resolveThinkingLevelV4WithUncertainty clamps an out-of-spec bias magnitude to the documented +-2 bound, never throwing or leaving the ladder", () => {
		const verdict = classifyTaskV4({ prompt: SPELLING_PROMPT });

		expect(() => resolveThinkingLevelV4WithUncertainty(verdict, FULL_LEVEL_SET, undefined, 99, null)).not.toThrow();
		expect(resolveThinkingLevelV4WithUncertainty(verdict, FULL_LEVEL_SET, undefined, 99, null)).toBe(
			resolveThinkingLevelV4WithUncertainty(verdict, FULL_LEVEL_SET, undefined, 2, null),
		);
		expect(resolveThinkingLevelV4WithUncertainty(verdict, FULL_LEVEL_SET, undefined, -99, null)).toBe(
			resolveThinkingLevelV4WithUncertainty(verdict, FULL_LEVEL_SET, undefined, -2, null),
		);
	});
});
