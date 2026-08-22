/**
 * Design-fidelity note: this file implements the Work Packet on-disk schema and supporting
 * type vocabulary defined in Part 1 (`final-part1-core-algorithm.md`), Sections 1, 2, 3, 4,
 * and 7. It is an implementation of that document, not a restatement of it — see the design
 * doc for rationale, transition semantics, and the open questions left for other lanes.
 */

/**
 * Work Packet lifecycle states.
 *
 * Part 1 §2 — the fourteen states of the packet-level state machine, including the
 * ESCALATED / AWAITING_APPROVAL / ADJUDICATION_FAILED additions from this revision.
 */
export type WorkPacketState =
	| "DRAFTED"
	| "ROUTED"
	| "AWAITING_APPROVAL"
	| "DISPATCHED"
	| "ACTIVE"
	| "HALTING"
	| "RAW_TERMINAL"
	| "UNDER_REVIEW"
	| "ADJUDICATION_FAILED"
	| "CONFIRMED"
	| "DECLINED"
	| "RETRY_QUEUED"
	| "ESCALATED"
	| "CLOSED";

/**
 * Part 1 §3.3 — whether a Dispatch Record's run_id set was produced by a single
 * `adaptorch_run` call (`single_call`) or by N calls the loop itself issued (`fanout_n`).
 * This tag is what lets the rest of the state machine stay agnostic to the Section 3.2
 * single-call-vs-client-side-fanout ambiguity.
 */
export type CardinalityMode = "single_call" | "fanout_n";

/** Current `adaptorch_route_topology` values, synchronized with AdaptOrch's `Topology` enum. */
export const TOPOLOGY_CLASSIFICATIONS = [
	"parallel",
	"sequential",
	"hierarchical",
	"hybrid",
	"multi_model_ensemble",
	"multi_turn_debate",
] as const;

export type TopologyClassification = (typeof TOPOLOGY_CLASSIFICATIONS)[number];

const TOPOLOGY_CLASSIFICATION_SET: ReadonlySet<string> = new Set(TOPOLOGY_CLASSIFICATIONS);

export function isTopologyClassification(value: unknown): value is TopologyClassification {
	return typeof value === "string" && TOPOLOGY_CLASSIFICATION_SET.has(value);
}

/**
 * Part 1 §3.3 / §7 — one concrete submission attempt for a Work Packet. A Dispatch Record
 * holds a run_id *set* (not a single run_id) tagged with its cardinality mode, so polling,
 * cancellation, and review packaging work the same way regardless of which Section 3.2
 * reading turns out to be correct.
 */
export interface DispatchRecord {
	attempt_n: number;
	cardinality_mode: CardinalityMode;
	run_ids: string[];
	submitted_at: string;
	mode: "blocking" | "polling";
	terminal_status?: string;
	terminal_at?: string;
}

/**
 * Part 1 §7 — one append-only entry in a Work Packet's transition log. Recorded for every
 * state change, including adjudication-call failures that have no `AdjudicationResult` to
 * archive elsewhere.
 */
export interface TransitionLogEntry {
	from: WorkPacketState;
	to: WorkPacketState;
	at: string;
	cause: string;
}

/**
 * Part 1 §1 / §7 — the Work Packet: the durable unit of intent this loop manages, potentially
 * resubmitted across several Dispatch Records over its life.
 *
 * The design doc (§7) also describes `adjudication_retry_count` (a separate bounded counter
 * for retrying the `adjudicate()` call itself, Part 1 §2/§6) and
 * `last_human_approved_topology_class` as persisted fields. Those are not modeled on this
 * type in this cut; a later change can add them without breaking the fields defined here.
 */
export interface WorkPacket {
	packet_id: string;
	kind: string;
	created_at: string;
	payload: unknown;
	topology_decision: {
		classification: TopologyClassification;
		decided_at: string;
		raw_route_response: unknown;
	} | null;
	dispatch_records: DispatchRecord[];
	state: WorkPacketState;
	retry_count: number;
	transition_log: TransitionLogEntry[];
	last_adjudication_ref: string | null;
	/** Part 1 §4 — the per-packet attempt budget (`max_dispatch_attempts`) and how much of it has been used. */
	attempt_budget: {
		max_dispatch_attempts: number;
		dispatch_attempts_used: number;
	};
	/**
	 * Part 1 §2 state 3 / §7 — the payload most recently approved by a human reviewer (or the
	 * original payload at creation, implicitly approved). `null` only if the packet has not yet
	 * been assigned an initial baseline. Used by `requiresHumanApproval` to decide whether the
	 * next attempt needs an AWAITING_APPROVAL gate before its first dispatch.
	 */
	last_human_approved_payload: unknown | null;
}

/**
 * Part 1 §4 — the named reasons the loop stops admitting new DRAFTED packets and begins
 * draining. `capacity_ceiling` and the cardinality-mismatch guard are soft governors (they
 * reduce admission/concurrency rather than terminating the loop outright); the others are
 * hard termination conditions.
 */
export type LoopTerminationCondition =
	| "completion_exhaustion"
	| "per_packet_attempt_budget"
	| "wall_clock_budget"
	| "dispatch_call_budget"
	| "stagnation_guard"
	| "capacity_ceiling"
	| "external_abort";

/**
 * Part 1 §4 — loop-instance configuration. Per the "Budget immutability" rule in §4, every
 * field here is fixed at loop-instance creation and must not be mutated for that instance's
 * lifetime; raising a threshold requires starting a new loop instance.
 */
export interface LoopConfig {
	loop_instance_id: string;
	/** Part 1 §4 "Per-packet attempt budget" — illustrative default in the design doc is 3. */
	max_dispatch_attempts_per_packet: number;
	/** Part 1 §4 "Loop wall-clock budget", expressed in milliseconds. */
	max_loop_duration_ms: number;
	/** Part 1 §4 "Loop dispatch-call budget" — total `adaptorch_run` invocations allowed across the loop's life. */
	max_total_dispatch_calls: number;
	/**
	 * Part 1 §4 "Stagnation guard" — the number of consecutive loop-wide DECLINED verdicts
	 * with indistinguishable evidence (same reason text / same evidence digest) that triggers
	 * a halt.
	 */
	stagnation_repeat_threshold: number;
	/**
	 * Part 1 §4 "Capacity ceiling (soft governor)". Shape chosen for this implementation, not
	 * dictated verbatim by the design doc: a saturation fraction/duration pair that must be
	 * sustained before the governor engages, and the reduced concurrency ceiling it engages to.
	 */
	capacity_governor_thresholds: {
		/** Fraction (0-1) of `adaptorch_server_metrics` saturation considered "sustained saturation". */
		saturation_threshold: number;
		/** How long saturation must persist, in milliseconds, before the governor engages. */
		sustained_duration_ms: number;
		/** Concurrency budget (max packets allowed into ACTIVE at once) while the governor is engaged. */
		reduced_concurrency_ceiling: number;
	};
	/**
	 * Part 1 §2 state 3 — the documented opt-in escape hatch that skips AWAITING_APPROVAL
	 * for every attempt in this loop instance, regardless of payload/topology drift.
	 */
	pre_approved_batch: boolean;
	/**
	 * Part 1 §3.4 — the result of the one-time cardinality calibration probe, or `null` before
	 * that probe has run. Continuously cross-checked (at zero extra call cost) against later
	 * `adaptorch_get_run`/reconciliation-sweep observations per §3.4.
	 */
	observed_cardinality_mode: CardinalityMode | null;
}

/**
 * Part 1 §7 — on-disk file layout constants, rooted at a loop-instance directory. Exported so
 * other modules never hardcode these path segments.
 */
export const PACKETS_DIR = "packets";
export const PACKET_INDEX_FILE = "packet_index.json";
export const RUN_MAP_FILE = "run_map.json";
export const LOOP_STATE_FILE = "loop_state.json";
export const ADJUDICATIONS_DIR = "adjudications";
