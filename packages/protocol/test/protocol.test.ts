import { describe, expect, it } from "vitest";
import {
	type EvaluationInput,
	evaluateTask,
	type Observation,
	PROTOCOL_VERSION,
	type RuntimeDecisionPolicy,
	reduceRuntimeDecision,
	type TaskSpec,
	type WaiverRecord,
} from "../src/index.ts";

const task: TaskSpec = {
	schemaVersion: PROTOCOL_VERSION,
	taskId: "task-1",
	goal: "Ship only after verification",
	createdAt: "2026-08-16T00:00:00.000Z",
	claims: [
		{
			claimId: "tests-pass",
			statement: "The focused test suite passes",
			requirement: "required",
			condition: {
				kind: "observation",
				observationKind: "test_run",
				scope: "attempt",
				facts: { exitCode: 0 },
			},
		},
	],
};

const attempt: EvaluationInput["attempt"] = {
	schemaVersion: PROTOCOL_VERSION,
	attemptId: "attempt-1",
	taskId: task.taskId,
	sequence: 1,
	trigger: "initial",
	startedAt: "2026-08-16T00:01:00.000Z",
	finishedAt: "2026-08-16T00:02:00.000Z",
	executor: { kind: "agent", provider: "faux", model: "test" },
	outcome: { kind: "completed" },
};

function observation(facts: Observation["facts"]): Observation {
	return {
		schemaVersion: PROTOCOL_VERSION,
		observationId: "observation-1",
		taskId: task.taskId,
		attemptId: attempt.attemptId,
		observedAt: "2026-08-16T00:01:30.000Z",
		kind: "test_run",
		source: { kind: "command", id: "npm-test" },
		facts,
		evidenceRefs: ["receipt:test-1"],
	};
}

function evaluate(observations: readonly Observation[], waivers: readonly WaiverRecord[] = []) {
	return evaluateTask({
		evaluationId: "evaluation-1",
		evaluatedAt: "2026-08-16T00:03:00.000Z",
		taskSpec: task,
		attempt,
		observations,
		waivers,
	});
}

describe("evaluateTask", () => {
	it("derives pass from immutable observations without mutating its inputs", () => {
		const observed = observation({ exitCode: 0, command: "npm test" });
		const before = structuredClone(observed);

		const result = evaluate([observed]);

		expect(result.semanticVerdict).toBe("pass");
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.claims)).toBe(true);
		expect(Object.isFrozen(result.claims[0])).toBe(true);
		expect(result.claims).toEqual([
			expect.objectContaining({
				claimId: "tests-pass",
				result: "satisfied",
				observationIds: ["observation-1"],
			}),
		]);
		expect(observed).toEqual(before);
	});

	it("distinguishes contradictory evidence from missing evidence", () => {
		expect(evaluate([observation({ exitCode: 1 })]).semanticVerdict).toBe("fail");
		const missing = evaluate([]);
		expect(missing.semanticVerdict).toBe("inconclusive");
		expect(missing.claims[0]).toEqual(
			expect.objectContaining({ result: "inconclusive", reasonCode: "claim.observation_missing" }),
		);
	});

	it("applies only explicit, in-scope, unexpired waivers", () => {
		const waiver: WaiverRecord = {
			schemaVersion: PROTOCOL_VERSION,
			waiverId: "waiver-1",
			scope: { taskId: task.taskId, claimId: "tests-pass", attemptId: attempt.attemptId },
			approvedBy: "release-manager",
			approvedAt: "2026-08-16T00:02:30.000Z",
			expiresAt: "2026-08-17T00:00:00.000Z",
			rationale: "External runner outage is tracked separately",
			evidenceRefs: ["incident:runner-123"],
		};

		const result = evaluate([observation({ exitCode: 1 })], [waiver]);

		expect(result.semanticVerdict).toBe("pass");
		expect(result.claims[0]).toEqual(expect.objectContaining({ result: "violated", waiverId: "waiver-1" }));
		expect(() =>
			evaluate([observation({ exitCode: 1 })], [{ ...waiver, expiresAt: "2026-08-15T00:00:00.000Z" }]),
		).toThrow(/waiver-1.*expired/);
	});

	it("rejects cross-task facts instead of silently evaluating them", () => {
		expect(() => evaluate([{ ...observation({ exitCode: 0 }), taskId: "other-task" }])).toThrow(
			/observation-1.*other-task/,
		);
	});
});

describe("reduceRuntimeDecision", () => {
	const policy: RuntimeDecisionPolicy = {
		onFail: "failover",
		onInconclusive: "retry",
	};

	it.each([
		["pass", "stop", "evaluation.pass"],
		["fail", "failover", "evaluation.fail"],
		["inconclusive", "retry", "evaluation.inconclusive"],
	] as const)("maps %s to %s", (semanticVerdict, action, reasonCode) => {
		const evaluation = { ...evaluate([observation({ exitCode: 0 })]), semanticVerdict };

		const decision = reduceRuntimeDecision({
			decisionId: "decision-1",
			decidedAt: "2026-08-16T00:04:00.000Z",
			evaluation,
			policy,
		});

		expect(decision).toEqual(
			expect.objectContaining({
				action,
				reasonCode,
				evaluationId: "evaluation-1",
			}),
		);
		expect(Object.isFrozen(decision)).toBe(true);
	});
});
