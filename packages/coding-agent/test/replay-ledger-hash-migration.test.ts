import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayLedgerManager } from "../src/guardrails/evidence-system.ts";
import { EMPTY_REPLAY_LEDGER_HEAD, ReplayLedgerStore } from "../src/guardrails/replay-ledger-store.ts";
import { computeReplayPayloadHash, JCS_REPLAY_PAYLOAD_HASH_ALGORITHM } from "../src/guardrails/replay-payload-hash.ts";
import type { ReplayEvent } from "../src/types/evidence.ts";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function jsonRoundTrip(value: unknown): unknown {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new TypeError("Expected a JSON value");
	const parsed: unknown = JSON.parse(serialized);
	return parsed;
}

function legacyEvent(goalId: string, payload: unknown): ReplayEvent {
	const payloadHash = sha256(JSON.stringify(payload));
	const chained = {
		seq: 1,
		type: "tool_call" as const,
		timestamp: "2026-08-16T00:00:00.000Z",
		goalId,
		payload,
		payloadHash,
		prevHash: "genesis",
	};
	return {
		...chained,
		eventHash: sha256(
			JSON.stringify([
				chained.seq,
				chained.type,
				chained.timestamp,
				chained.goalId,
				null,
				chained.payloadHash,
				chained.prevHash,
			]),
		),
	};
}

function installCommittedLine(path: string, lineValue: object, eventHash: string): Buffer {
	const line = Buffer.from(`${JSON.stringify(lineValue)}\n`, "utf8");
	const store = new ReplayLedgerStore(path, (bytes) => {
		if (bytes.byteLength === 0) return { lastSeq: 0, lastHash: "genesis" };
		const lines = bytes.toString("utf8").trim().split("\n");
		const last: unknown = JSON.parse(lines[lines.length - 1] ?? "null");
		if (typeof last !== "object" || last === null || !("seq" in last) || !("eventHash" in last)) {
			throw new TypeError("invalid replay fixture");
		}
		if (typeof last.seq !== "number" || typeof last.eventHash !== "string") {
			throw new TypeError("invalid replay fixture head");
		}
		return { lastSeq: last.seq, lastHash: last.eventHash };
	});
	store.append(line, 1, eventHash, EMPTY_REPLAY_LEDGER_HEAD);
	return line;
}

function hashAlgorithm(event: ReplayEvent): unknown {
	return event.payloadHashAlgorithm;
}

describe("replay ledger payload-hash migration", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "omk-replay-hash-migration-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reads v1, appends v2 without rewriting history, and preserves algorithms on export", () => {
		const goalId = "migration-goal";
		const ledgerPath = join(root, "ledger.jsonl");
		const exportPath = join(root, "export.json");
		const legacy = legacyEvent(goalId, { z: 1, a: 2 });
		const legacyLine = installCommittedLine(ledgerPath, legacy, legacy.eventHash);

		const manager = new ReplayLedgerManager(goalId, ledgerPath);
		expect(hashAlgorithm(manager.getEvents()[0])).toBeUndefined();
		const appended = manager.append({ type: "tool_call", goalId, payload: { z: 3, a: 4 } });

		expect(hashAlgorithm(appended)).toBe(JCS_REPLAY_PAYLOAD_HASH_ALGORITHM);
		expect(appended.payloadHash).toBe(computeReplayPayloadHash(appended.payload, JCS_REPLAY_PAYLOAD_HASH_ALGORITHM));
		expect(readFileSync(ledgerPath).subarray(0, legacyLine.byteLength)).toEqual(legacyLine);
		expect(new ReplayLedgerManager(goalId, ledgerPath).getEvents()).toHaveLength(2);

		manager.exportToFile(exportPath);
		const exported: unknown = JSON.parse(readFileSync(exportPath, "utf8"));
		expect(Array.isArray(exported)).toBe(true);
		if (!Array.isArray(exported)) throw new TypeError("expected replay array");
		expect(exported[0]).not.toHaveProperty("payloadHashAlgorithm");
		expect(exported[1]).toHaveProperty("payloadHashAlgorithm", JCS_REPLAY_PAYLOAD_HASH_ALGORITHM);
	});

	it("verifies generated mixed legacy and JCS chains without rewriting v1 events", () => {
		let caseId = 0;
		fc.assert(
			fc.property(fc.jsonValue(), fc.jsonValue(), (legacyPayload, newPayload) => {
				const goalId = `mixed-goal-${caseId}`;
				const ledgerPath = join(root, `mixed-${caseId}.jsonl`);
				caseId += 1;
				const legacy = legacyEvent(goalId, legacyPayload);
				const legacyLine = installCommittedLine(ledgerPath, legacy, legacy.eventHash);
				const manager = new ReplayLedgerManager(goalId, ledgerPath);
				manager.append({ type: "tool_call", goalId, payload: newPayload });

				const events = new ReplayLedgerManager(goalId, ledgerPath).getEvents();
				expect(events).toHaveLength(2);
				expect(hashAlgorithm(events[0])).toBeUndefined();
				expect(hashAlgorithm(events[1])).toBe(JCS_REPLAY_PAYLOAD_HASH_ALGORITHM);
				expect(events[0]?.payload).toEqual(jsonRoundTrip(legacyPayload));
				expect(events[1]?.payload).toEqual(jsonRoundTrip(newPayload));
				expect(readFileSync(ledgerPath).subarray(0, legacyLine.byteLength)).toEqual(legacyLine);
			}),
			{ numRuns: 30, seed: 0x0fc52026 },
		);
	});

	it("binds the declared algorithm into the event hash to reject downgrade tampering", () => {
		const goalId = "algorithm-downgrade-goal";
		const sourcePath = join(root, "source.jsonl");
		const tamperedPath = join(root, "downgraded.jsonl");
		const event = new ReplayLedgerManager(goalId, sourcePath).append({
			type: "tool_call",
			goalId,
			payload: { a: 1 },
		});
		const downgraded = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "payloadHashAlgorithm"));
		installCommittedLine(tamperedPath, downgraded, event.eventHash);

		expect(() => new ReplayLedgerManager(goalId, tamperedPath)).toThrow(/event hash mismatch/i);
	});

	it("fails closed on an unknown declared payload hash algorithm", () => {
		const goalId = "unknown-algorithm-goal";
		const ledgerPath = join(root, "unknown.jsonl");
		const legacy = legacyEvent(goalId, { value: 1 });
		installCommittedLine(ledgerPath, { ...legacy, payloadHashAlgorithm: "untrusted-v99" }, legacy.eventHash);

		expect(() => new ReplayLedgerManager(goalId, ledgerPath)).toThrow(/payload hash algorithm|algorithm/i);
	});
});
