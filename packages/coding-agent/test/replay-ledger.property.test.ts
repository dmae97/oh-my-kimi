import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ReplayLedgerManager } from "../src/guardrails/evidence-system.ts";
import { JCS_REPLAY_PAYLOAD_HASH_ALGORITHM } from "../src/guardrails/replay-payload-hash.ts";

function jsonRoundTrip(value: unknown): unknown {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new TypeError("Expected a JSON value");
	const parsed: unknown = JSON.parse(serialized);
	return parsed;
}

describe("replay ledger concurrency properties", () => {
	it("commits exactly one winner when two managers race from the same durable head", () => {
		fc.assert(
			fc.property(fc.jsonValue(), fc.jsonValue(), fc.boolean(), (leftPayload, rightPayload, leftWins) => {
				const root = mkdtempSync(join(tmpdir(), "omk-replay-cas-property-"));
				try {
					const goalId = "cas-property-goal";
					const path = join(root, "ledger.jsonl");
					const left = new ReplayLedgerManager(goalId, path);
					const right = new ReplayLedgerManager(goalId, path);
					const winner = leftWins ? left : right;
					const loser = leftWins ? right : left;
					const winnerPayload = leftWins ? leftPayload : rightPayload;
					const loserPayload = leftWins ? rightPayload : leftPayload;

					const committed = winner.append({ type: "tool_call", goalId, payload: winnerPayload });
					expect(() => loser.append({ type: "tool_call", goalId, payload: loserPayload })).toThrow(
						/CAS|concurrent/i,
					);

					const durable = new ReplayLedgerManager(goalId, path).getEvents();
					expect(durable).toHaveLength(1);
					expect(durable[0]?.eventHash).toBe(committed.eventHash);
					expect(durable[0]?.payload).toEqual(jsonRoundTrip(winnerPayload));
					expect(durable[0]?.payloadHashAlgorithm).toBe(JCS_REPLAY_PAYLOAD_HASH_ALGORITHM);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
			{ numRuns: 30, seed: 0x0fc52026 },
		);
	});
});
