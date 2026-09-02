import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialHarnessLifecycleState, reduceHarnessLifecycle } from "../../src/harness/operation-lifecycle-reducer.ts";
import type {
	HarnessLifecycleCommand,
	HarnessLifecycleState,
	HarnessOperationKind,
} from "../../src/harness/operation-lifecycle-types.ts";

/**
 * Model-guided random walk over the lifecycle graph. Each step enumerates the
 * commands legal for the current model state, picks one by drawn index, and
 * occasionally injects an arbitrary command. Invariants are checked after
 * every accepted command, so a counterexample is a full replayable trace.
 */

interface WalkContext {
	operationSeq: number;
	attemptIndex: number;
	settledIds: string[];
}

function legalCommands(state: HarnessLifecycleState, context: WalkContext): HarnessLifecycleCommand[] {
	if (state.tag === "idle") {
		const kinds: HarnessOperationKind[] = [
			"prompt",
			"skill",
			"prompt_template",
			"manual_compaction",
			"tree_navigation",
		];
		return kinds.map((kind) => ({
			type: "begin",
			operation: {
				operationId: `op-${context.operationSeq}`,
				sequence: context.operationSeq,
				kind,
				startedAtMs: 0,
			},
		}));
	}
	if (state.tag === "settling") {
		return [{ type: "settle_finish", operationId: state.operation.operationId }];
	}
	const opId = state.operation.operationId;
	const settle: HarnessLifecycleCommand = {
		type: "settle_begin",
		operationId: opId,
		outcome: { status: "completed" },
	};
	const abort: HarnessLifecycleCommand = { type: "abort_request", operationId: opId };
	const promptFamily =
		state.operation.kind === "prompt" ||
		state.operation.kind === "skill" ||
		state.operation.kind === "prompt_template";
	switch (state.stage) {
		case "preparing": {
			const commands: HarnessLifecycleCommand[] = [settle, abort];
			if (promptFamily && state.attempts.length === 0) {
				commands.push({
					type: "attempt_begin",
					attempt: { operationId: opId, attemptId: `${opId}:a0`, index: 0, reason: "initial", startedAtMs: 0 },
				});
			}
			// Recovery is legal only as a response to the last closed attempt overflowing.
			if (promptFamily && state.attempts.at(-1)?.outcome === "overflow") {
				commands.push({ type: "stage", operationId: opId, stage: "recovering_overflow" });
			}
			if (!promptFamily) commands.push({ type: "stage", operationId: opId, stage: "structural_running" });
			return commands;
		}
		// An open attempt must be closed before settling, so `settle` is not a
		// legal move from either attempt-open stage.
		case "attempt_running":
			return [
				{ type: "stage", operationId: opId, stage: "save_point" },
				{ type: "attempt_end", attemptId: `${opId}:a${state.attempts.length}`, outcome: "completed" },
				{ type: "attempt_end", attemptId: `${opId}:a${state.attempts.length}`, outcome: "overflow" },
				{ type: "attempt_end", attemptId: `${opId}:a${state.attempts.length}`, outcome: "aborted" },
				abort,
			];
		case "save_point":
			return [
				{ type: "stage", operationId: opId, stage: "attempt_running" },
				{ type: "attempt_end", attemptId: `${opId}:a${state.attempts.length}`, outcome: "completed" },
				abort,
			];
		case "recovering_overflow":
			return [
				{
					type: "attempt_begin",
					attempt: {
						operationId: opId,
						attemptId: `${opId}:a${state.attempts.length}`,
						index: state.attempts.length,
						reason: "context_overflow_recovery",
						startedAtMs: 0,
					},
				},
				settle,
				abort,
			];
		case "structural_running":
			return [{ type: "stage", operationId: opId, stage: "committing" }, settle, abort];
		case "committing":
		case "settling":
			return [settle, abort];
	}
}

function arbitraryCommand(): fc.Arbitrary<HarnessLifecycleCommand> {
	const id = fc.constantFrom("op-0", "op-1", "op-2", "op-x");
	const outcome = fc.constantFrom(
		{ status: "completed" } as const,
		{ status: "failed", code: "session", message: "flush failed" } as const,
		{ status: "aborted" } as const,
		{ status: "cancelled", reason: "user" } as const,
	);
	return fc.oneof(
		id.chain((operationId) =>
			fc.constantFrom<HarnessLifecycleCommand>(
				{ type: "stage", operationId, stage: "save_point" },
				{ type: "stage", operationId, stage: "structural_running" },
				{ type: "stage", operationId, stage: "recovering_overflow" },
				{ type: "abort_request", operationId },
				{ type: "settle_finish", operationId },
			),
		),
		id.chain((operationId) =>
			outcome.map((o): HarnessLifecycleCommand => ({ type: "settle_begin", operationId, outcome: o })),
		),
		id.chain((operationId) =>
			fc.integer({ min: 0, max: 3 }).map(
				(index): HarnessLifecycleCommand => ({
					type: "attempt_begin",
					attempt: {
						operationId,
						attemptId: `${operationId}:a${index}`,
						index,
						reason: "initial" as const,
						startedAtMs: 0,
					},
				}),
			),
		),
		id.map(
			(operationId): HarnessLifecycleCommand => ({
				type: "attempt_end",
				attemptId: `${operationId}:a0`,
				outcome: "failed",
			}),
		),
	);
}

function assertStateShape(state: HarnessLifecycleState): void {
	if (state.tag === "idle") {
		expect(state.lastSequence).toBeGreaterThanOrEqual(0);
		return;
	}
	expect(state.operation.sequence).toBeGreaterThanOrEqual(1);
	state.attempts.forEach((record, index) => {
		expect(record.attempt.index).toBe(index);
		expect(record.attempt.operationId).toBe(state.operation.operationId);
	});
	if (state.tag === "active") {
		if (state.stage === "attempt_running" || state.stage === "save_point") {
			expect(state.attempt).toBeDefined();
			expect(state.attempt?.operationId).toBe(state.operation.operationId);
			expect(state.attempt?.index).toBe(state.attempts.length);
		} else {
			expect(state.attempt).toBeUndefined();
		}
		if (state.operation.kind === "manual_compaction" || state.operation.kind === "tree_navigation") {
			expect(state.attempts).toHaveLength(0);
			expect(state.attempt).toBeUndefined();
		}
	}
}

function walk(choices: number[], injected: (HarnessLifecycleCommand | null)[]): HarnessLifecycleState {
	let state = initialHarnessLifecycleState();
	const context: WalkContext = { operationSeq: 1, attemptIndex: 0, settledIds: [] };
	const startedAttempts: string[] = [];
	const finishedAttempts: string[] = [];
	for (let step = 0; step < choices.length; step += 1) {
		const inject = injected[step];
		const command =
			inject ??
			(() => {
				const legal = legalCommands(state, context);
				const picked = legal[choices[step]! % legal.length]!;
				if (picked.type === "begin" && picked.operation.kind === "prompt") return legal[0]!;
				return picked;
			})();
		const before = state;
		const next = reduceHarnessLifecycle(state, command);
		if (!next.ok) {
			expect(next.error.state).toBe(before);
			continue;
		}
		state = next.value;
		assertStateShape(state);
		if (command.type === "begin") context.operationSeq += 1;
		if (command.type === "attempt_begin") startedAttempts.push(command.attempt.attemptId);
		if (command.type === "attempt_end") finishedAttempts.push(command.attemptId);
		if (command.type === "settle_begin") {
			// An accepted settle proves no attempt was left open, and that every
			// attempt started so far was closed in the order it was started.
			expect(before.tag).toBe("active");
			if (before.tag === "active") expect(before.attempt).toBeUndefined();
			expect(finishedAttempts).toEqual(startedAttempts);
			expect(context.settledIds).not.toContain(command.operationId);
			context.settledIds.push(command.operationId);
		}
		if (command.type === "settle_finish" && state.tag === "idle") {
			expect(before.tag).toBe("settling");
			if (before.tag === "settling") expect(state.lastSequence).toBe(before.operation.sequence);
		}
	}
	return state;
}

describe("operation lifecycle reducer property", () => {
	it("random walks keep the state machine consistent and settle exactly once per operation", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 16 }), { minLength: 1, maxLength: 120 }),
				fc.array(
					fc.oneof(
						fc.constant(null),
						arbitraryCommand().map((c) => c as HarnessLifecycleCommand | null),
					),
					{
						minLength: 1,
						maxLength: 120,
					},
				),
				(choices, injectedRaw) => {
					const length = choices.length;
					const injected = Array.from({ length }, (_, index) => injectedRaw[index % injectedRaw.length] ?? null);
					walk(choices, injected);
				},
			),
			{ numRuns: 1000, seed: 0x90c1ec1e },
		);
	});

	it("is deterministic for identical command streams", () => {
		fc.assert(
			fc.property(fc.array(arbitraryCommand(), { minLength: 0, maxLength: 40 }), (commands) => {
				const run = (): readonly string[] => {
					let state = initialHarnessLifecycleState();
					return commands.map((command) => {
						const next = reduceHarnessLifecycle(state, command);
						if (!next.ok) return `violation:${next.error.code}`;
						state = next.value;
						return `ok:${state.tag}${state.tag === "active" ? `:${state.stage}` : ""}`;
					});
				};
				expect(run()).toEqual(run());
			}),
			{ numRuns: 500, seed: 0x90c1ec1e },
		);
	});
});
