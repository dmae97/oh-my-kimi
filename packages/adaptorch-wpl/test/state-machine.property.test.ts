import fc, { type Command } from "fast-check";
import { describe, expect, it } from "vitest";
import { applyTransition, canTransition, isTerminalState } from "../src/state-machine.ts";
import type { WorkPacket, WorkPacketState } from "../src/types.ts";

const STATES = [
	"DRAFTED",
	"ROUTED",
	"AWAITING_APPROVAL",
	"DISPATCHED",
	"ACTIVE",
	"HALTING",
	"RAW_TERMINAL",
	"UNDER_REVIEW",
	"ADJUDICATION_FAILED",
	"CONFIRMED",
	"DECLINED",
	"RETRY_QUEUED",
	"ESCALATED",
	"CLOSED",
] as const satisfies readonly WorkPacketState[];

interface StateModel {
	state: WorkPacketState;
	acceptedTransitions: number;
	closedTransitions: number;
}

interface StateSystem {
	packet: WorkPacket;
}

function packet(): WorkPacket {
	return {
		packet_id: "property-packet",
		kind: "test",
		created_at: "2026-01-01T00:00:00.000Z",
		payload: {},
		topology_decision: null,
		dispatch_records: [],
		state: "DRAFTED",
		retry_count: 0,
		transition_log: [],
		last_adjudication_ref: null,
		attempt_budget: { max_dispatch_attempts: 3, dispatch_attempts_used: 0 },
		last_human_approved_payload: {},
	};
}

class TransitionCommand implements Command<StateModel, StateSystem> {
	private readonly target: WorkPacketState;

	constructor(target: WorkPacketState) {
		this.target = target;
	}

	check(): boolean {
		return true;
	}

	run(model: StateModel, system: StateSystem): void {
		const before = system.packet;
		const legal = canTransition(model.state, this.target);
		if (!legal) {
			expect(() =>
				applyTransition(before, this.target, "property transition", () => "2026-01-01T00:00:01.000Z"),
			).toThrow(/Illegal work packet transition/);
			expect(system.packet).toBe(before);
			return;
		}

		const next = applyTransition(before, this.target, "property transition", () => "2026-01-01T00:00:01.000Z");
		expect(before.state).toBe(model.state);
		expect(before.transition_log).toHaveLength(model.acceptedTransitions);
		expect(next.state).toBe(this.target);
		expect(next.transition_log).toHaveLength(model.acceptedTransitions + 1);

		model.state = this.target;
		model.acceptedTransitions += 1;
		if (this.target === "CLOSED") model.closedTransitions += 1;
		expect(model.closedTransitions).toBeLessThanOrEqual(1);
		expect(isTerminalState(next.state)).toBe(next.state === "CLOSED");
		system.packet = next;
	}

	toString(): string {
		return `transition(${this.target})`;
	}
}

const commandArbitrary = fc.constantFrom(...STATES).map((state) => new TransitionCommand(state));

describe("WPL state-machine properties", () => {
	it("keeps the model and implementation aligned across generated transition traces", () => {
		fc.assert(
			fc.property(fc.commands([commandArbitrary], { maxCommands: 80 }), (commands) => {
				fc.modelRun(
					() => ({
						model: { state: "DRAFTED", acceptedTransitions: 0, closedTransitions: 0 } satisfies StateModel,
						real: { packet: packet() },
					}),
					commands,
				);
			}),
			{ numRuns: 250, seed: 0x0fc52026 },
		);
	});

	it("never permits a transition after CLOSED", () => {
		fc.assert(
			fc.property(fc.constantFrom(...STATES), (target) => {
				expect(canTransition("CLOSED", target)).toBe(false);
				expect(() => applyTransition({ ...packet(), state: "CLOSED" }, target, "closed invariant")).toThrow(
					/CLOSED/,
				);
			}),
			{ numRuns: 250, seed: 0x0fc52026 },
		);
	});
});
