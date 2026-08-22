import { describe, expect, it } from "vitest";
import { applyTransition, canTransition, isTerminalState, requiresHumanApproval } from "../src/state-machine.ts";
import type { LoopConfig, WorkPacket } from "../src/types.ts";

function makePacket(overrides: Partial<WorkPacket> = {}): WorkPacket {
	return {
		packet_id: "pkt-1",
		kind: "code-edit",
		created_at: "2026-01-01T00:00:00.000Z",
		payload: { foo: "bar" },
		topology_decision: null,
		dispatch_records: [],
		state: "DRAFTED",
		retry_count: 0,
		transition_log: [],
		last_adjudication_ref: null,
		attempt_budget: { max_dispatch_attempts: 3, dispatch_attempts_used: 0 },
		last_human_approved_payload: { foo: "bar" },
		...overrides,
	};
}

function makeLoopConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
	return {
		loop_instance_id: "loop-1",
		max_dispatch_attempts_per_packet: 3,
		max_loop_duration_ms: 60_000,
		max_total_dispatch_calls: 100,
		stagnation_repeat_threshold: 3,
		capacity_governor_thresholds: {
			saturation_threshold: 0.9,
			sustained_duration_ms: 30_000,
			reduced_concurrency_ceiling: 1,
		},
		pre_approved_batch: false,
		observed_cardinality_mode: null,
		...overrides,
	};
}

describe("canTransition", () => {
	it("allows the documented happy path", () => {
		expect(canTransition("DRAFTED", "ROUTED")).toBe(true);
		expect(canTransition("ROUTED", "DISPATCHED")).toBe(true);
		expect(canTransition("DISPATCHED", "ACTIVE")).toBe(true);
		expect(canTransition("ACTIVE", "RAW_TERMINAL")).toBe(true);
		expect(canTransition("RAW_TERMINAL", "UNDER_REVIEW")).toBe(true);
		expect(canTransition("UNDER_REVIEW", "CONFIRMED")).toBe(true);
		expect(canTransition("CONFIRMED", "CLOSED")).toBe(true);
	});

	it("rejects illegal transitions", () => {
		expect(canTransition("DRAFTED", "CLOSED")).toBe(false);
		expect(canTransition("CLOSED", "ROUTED")).toBe(false);
		expect(canTransition("CONFIRMED", "DECLINED")).toBe(false);
	});

	it("never lets ESCALATED resume without going through RETRY_QUEUED or CLOSED", () => {
		expect(canTransition("ESCALATED", "DISPATCHED")).toBe(false);
		expect(canTransition("ESCALATED", "ACTIVE")).toBe(false);
		expect(canTransition("ESCALATED", "RETRY_QUEUED")).toBe(true);
		expect(canTransition("ESCALATED", "CLOSED")).toBe(true);
	});

	it("keeps DECLINED able to reach ESCALATED, RETRY_QUEUED, or CLOSED", () => {
		expect(canTransition("DECLINED", "ESCALATED")).toBe(true);
		expect(canTransition("DECLINED", "RETRY_QUEUED")).toBe(true);
		expect(canTransition("DECLINED", "CLOSED")).toBe(true);
	});
});

describe("applyTransition", () => {
	const fixedClock = () => "2026-06-01T00:00:00.000Z";

	it("returns a new packet with updated state and an appended transition log entry", () => {
		const packet = makePacket();
		const next = applyTransition(packet, "ROUTED", "topology routed", fixedClock);

		expect(next.state).toBe("ROUTED");
		expect(next.transition_log).toHaveLength(1);
		expect(next.transition_log[0]).toEqual({
			from: "DRAFTED",
			to: "ROUTED",
			at: "2026-06-01T00:00:00.000Z",
			cause: "topology routed",
		});
	});

	it("does not mutate the input packet", () => {
		const packet = makePacket();
		applyTransition(packet, "ROUTED", "topology routed", fixedClock);

		expect(packet.state).toBe("DRAFTED");
		expect(packet.transition_log).toHaveLength(0);
	});

	it("throws a descriptive error on an illegal transition", () => {
		const packet = makePacket({ state: "CLOSED" });
		expect(() => applyTransition(packet, "ROUTED", "bad", fixedClock)).toThrow(
			/Illegal work packet transition: CLOSED -> ROUTED/,
		);
	});
});

describe("isTerminalState", () => {
	it("is true only for CLOSED", () => {
		expect(isTerminalState("CLOSED")).toBe(true);
		expect(isTerminalState("ESCALATED")).toBe(false);
		expect(isTerminalState("RETRY_QUEUED")).toBe(false);
		expect(isTerminalState("CONFIRMED")).toBe(false);
	});
});

describe("requiresHumanApproval", () => {
	it("is false when payload and topology are unchanged", () => {
		const packet = makePacket({
			topology_decision: { classification: "sequential", decided_at: "t", raw_route_response: null },
		});
		const loopConfig = makeLoopConfig();
		expect(requiresHumanApproval(packet, { foo: "bar" }, "sequential", loopConfig)).toBe(false);
	});

	it("is true when the payload differs from the last human-approved baseline", () => {
		const packet = makePacket();
		const loopConfig = makeLoopConfig();
		expect(requiresHumanApproval(packet, { foo: "different" }, null, loopConfig)).toBe(true);
	});

	it("is true when the topology classification changes", () => {
		const packet = makePacket({
			topology_decision: { classification: "sequential", decided_at: "t", raw_route_response: null },
		});
		const loopConfig = makeLoopConfig();
		expect(requiresHumanApproval(packet, { foo: "bar" }, "multi_model_ensemble", loopConfig)).toBe(true);
	});

	it("is always false in pre-approved-batch mode, even with a changed payload", () => {
		const packet = makePacket();
		const loopConfig = makeLoopConfig({ pre_approved_batch: true });
		expect(requiresHumanApproval(packet, { foo: "different" }, "multi_model_ensemble", loopConfig)).toBe(false);
	});
});
