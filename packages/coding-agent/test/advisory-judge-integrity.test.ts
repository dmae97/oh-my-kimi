import { getModel } from "omk-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type AdvisoryJudge,
	type AdvisoryJudgeCompletion,
	AdvisoryJudgeModelError,
	chooseWithAdvisoryJudge,
	createModelAdvisoryJudge,
} from "../src/index.ts";
import { CANDIDATES, candidate, REQUEST, RESPONSE, RUBRIC, scores } from "./advisory-judge-integrity-fixtures.ts";
import { assistantMsg } from "./utilities.ts";

const MODEL = getModel("anthropic", "claude-sonnet-4-5");
if (!MODEL) throw new Error("test model missing");
const BASE = { taskGoal: "Compare the passing patches", judgeId: "judge-1", rubric: RUBRIC } as const;

function modelJudge(completion: AdvisoryJudgeCompletion): AdvisoryJudge {
	return createModelAdvisoryJudge({
		model: MODEL,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
		completion,
	});
}

describe("advisory selection execution integrity", () => {
	it("does not invoke a custom judge after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const judge = vi.fn<AdvisoryJudge>(async () => RESPONSE);
		const decision = await chooseWithAdvisoryJudge({
			...BASE,
			candidates: CANDIDATES,
			judge,
			signal: controller.signal,
		});
		expect(judge).not.toHaveBeenCalled();
		expect(decision).toMatchObject({ reason: "judge-unavailable", selectedCandidateId: "a" });
	});

	it("discards a custom judge response received after cancellation", async () => {
		const controller = new AbortController();
		const judge: AdvisoryJudge = async () => {
			controller.abort();
			return RESPONSE;
		};
		const decision = await chooseWithAdvisoryJudge({
			...BASE,
			candidates: CANDIDATES,
			judge,
			signal: controller.signal,
		});
		expect(decision).toMatchObject({ reason: "judge-unavailable", selectedCandidateId: "a" });
	});

	it.each(["length", "aborted", "toolUse", "error", "unknown", undefined, null, false])(
		"does not treat complete score JSON as success when stopReason is %s",
		async (stopReason) => {
			// Given identical, valid JSON but no normal completion evidence.
			const completion = vi.fn<AdvisoryJudgeCompletion>(async () => ({
				...assistantMsg(RESPONSE),
				stopReason,
			}));
			// When the real model adapter feeds the real public selection path.
			const decision = await chooseWithAdvisoryJudge({
				...BASE,
				candidates: CANDIDATES,
				judge: modelJudge(completion),
			});
			// Then the invalid execution cannot select the JSON's preferred candidate b.
			expect(decision).toMatchObject({
				status: "fallback",
				reason: "judge-unavailable",
				source: "deterministic",
				selectedCandidateId: "a",
				diagnostics: { comparison: "unavailable" },
			});
			expect(completion).toHaveBeenCalledTimes(1);
		},
	);

	it("uses a normally completed comparison without turning it into verification evidence", async () => {
		// Given completed scores and caller-owned protocol evaluations.
		const before = JSON.stringify(CANDIDATES);
		const decision = await chooseWithAdvisoryJudge({
			...BASE,
			candidates: CANDIDATES,
			judge: modelJudge(async () => assistantMsg(RESPONSE)),
		});
		// Then the unique winner and measured score margin are explicit; evaluations are untouched.
		expect(decision).toMatchObject({
			selectedCandidateId: "b",
			reason: "judge-ranked",
			source: "llm-judge",
			diagnostics: {
				comparison: "scored",
				ranking: { distinctScores: 2, topScoreTieCount: 1, scoreMargin: 3 },
			},
		});
		expect(JSON.stringify(CANDIDATES)).toBe(before);
	});

	it("performs no auth or completion work for an already-aborted request", async () => {
		// Given an explicit user cancellation before work begins.
		const controller = new AbortController();
		controller.abort();
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const }));
		const completion = vi.fn<AdvisoryJudgeCompletion>(async () => assistantMsg(RESPONSE));
		const judge = createModelAdvisoryJudge({ model: MODEL, modelRegistry: { getApiKeyAndHeaders }, completion });
		// When the SDK is called with the aborted signal.
		await expect(judge(REQUEST, controller.signal)).rejects.toEqual(new AdvisoryJudgeModelError("completion-failed"));
		// Then cancellation cannot spend on a judge.
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(completion).not.toHaveBeenCalled();
	});

	it("rechecks cancellation after asynchronous auth before calling the provider", async () => {
		// Given cancellation that becomes observable while auth is resolving.
		const controller = new AbortController();
		const completion = vi.fn<AdvisoryJudgeCompletion>(async () => assistantMsg(RESPONSE));
		const judge = createModelAdvisoryJudge({
			model: MODEL,
			modelRegistry: {
				getApiKeyAndHeaders: async () => {
					controller.abort();
					return { ok: true as const };
				},
			},
			completion,
		});
		await expect(judge(REQUEST, controller.signal)).rejects.toEqual(new AdvisoryJudgeModelError("completion-failed"));
		expect(completion).not.toHaveBeenCalled();
	});

	it("discards a late normal response when cancellation occurred during completion", async () => {
		// Given a completion seam that does not cooperate with cancellation.
		const controller = new AbortController();
		const judge = modelJudge(async () => {
			controller.abort();
			return assistantMsg(RESPONSE);
		});
		// When the late response arrives, cancellation remains authoritative.
		await expect(judge(REQUEST, controller.signal)).rejects.toEqual(new AdvisoryJudgeModelError("completion-failed"));
	});
});

describe("advisory selection evidence attribution", () => {
	it("states that a top-score tie was decided by caller rank, retaining every intake category", async () => {
		// Given two passes, one fail and one unknown; the scoring matrix ties only the passes.
		const candidates = [...CANDIDATES, candidate("failed", 2, "fail"), candidate("unknown", 3, "inconclusive")];
		const before = JSON.stringify(candidates);
		const judge = vi.fn<AdvisoryJudge>(async () =>
			scores([
				["b", 4],
				["a", 4],
			]),
		);
		const decision = await chooseWithAdvisoryJudge({ ...BASE, candidates, judge });
		// Then the same deterministic winner is chosen, without inventing a model preference.
		expect(decision).toMatchObject({
			status: "selected",
			reason: "judge-tied",
			source: "deterministic",
			selectedCandidateId: "a",
			diagnostics: {
				submittedCandidates: 4,
				eligibleCandidates: 2,
				excludedCandidates: { fail: 1, inconclusive: 1 },
				comparison: "scored",
				ranking: { distinctScores: 1, topScoreTieCount: 2, scoreMargin: 0 },
			},
		});
		expect(judge.mock.calls[0]?.[0].candidates.map(({ id }) => id)).toEqual(["a", "b"]);
		expect(JSON.stringify(candidates)).toBe(before);
	});

	it("tie-breaks within the highest-scoring group, not the global fallback candidate", async () => {
		// Given the earliest-ranked candidate is worse than a tied pair.
		const decision = await chooseWithAdvisoryJudge({
			...BASE,
			candidates: [...CANDIDATES, candidate("c", 2)],
			judge: async () =>
				scores([
					["a", 0],
					["b", 4],
					["c", 4],
				]),
		});
		expect(decision).toMatchObject({
			selectedCandidateId: "b",
			reason: "judge-tied",
			source: "deterministic",
			diagnostics: { ranking: { distinctScores: 2, topScoreTieCount: 2, scoreMargin: 0 } },
		});
	});

	it.each([0, 1])("does not report a measured comparison for %i eligible candidates", async (passes) => {
		const judge = vi.fn<AdvisoryJudge>(async () => RESPONSE);
		const candidates = [candidate("unknown", 2, "inconclusive"), ...CANDIDATES.slice(0, passes)];
		const decision = await chooseWithAdvisoryJudge({ ...BASE, candidates, judge });
		expect(decision).toMatchObject({
			status: "skipped",
			diagnostics: {
				submittedCandidates: passes + 1,
				eligibleCandidates: passes,
				excludedCandidates: { fail: 0, inconclusive: 1 },
				comparison: "not-compared",
			},
		});
		expect(decision.diagnostics?.ranking).toBeUndefined();
		expect(judge).not.toHaveBeenCalled();
	});

	it("distinguishes an invalid matrix from measured zero scores", async () => {
		const decision = await chooseWithAdvisoryJudge({ ...BASE, candidates: CANDIDATES, judge: async () => "{}" });
		expect(decision).toMatchObject({
			status: "fallback",
			reason: "judge-response-invalid",
			diagnostics: { comparison: "invalid" },
		});
		expect(decision.diagnostics?.ranking).toBeUndefined();
	});
});
