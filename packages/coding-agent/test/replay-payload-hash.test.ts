import { createHash } from "node:crypto";
import fc, { type JsonValue } from "fast-check";
import { describe, expect, it } from "vitest";
import {
	computeReplayPayloadHash,
	JCS_REPLAY_PAYLOAD_HASH_ALGORITHM,
	LEGACY_REPLAY_PAYLOAD_HASH_ALGORITHM,
	serializeReplayPayload,
} from "../src/guardrails/replay-payload-hash.ts";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function reverseObjectInsertionOrder(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(reverseObjectInsertionOrder);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.reverse()
			.map(([key, child]) => {
				if (child === undefined) throw new TypeError("Generated JSON object contains undefined");
				return [key, reverseObjectInsertionOrder(child)];
			}),
	);
}

describe("versioned replay payload hashing", () => {
	it("is deterministic across JSON object insertion order under JCS v2", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (payload) => {
				const reordered = reverseObjectInsertionOrder(payload);
				expect(computeReplayPayloadHash(payload, JCS_REPLAY_PAYLOAD_HASH_ALGORITHM)).toBe(
					computeReplayPayloadHash(reordered, JCS_REPLAY_PAYLOAD_HASH_ALGORITHM),
				);
			}),
			{ numRuns: 500, seed: 0x0fc52026 },
		);
	});

	it("detects generated payload tampering under JCS v2", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (payload) => {
				expect(computeReplayPayloadHash(payload, JCS_REPLAY_PAYLOAD_HASH_ALGORITHM)).not.toBe(
					computeReplayPayloadHash({ tampered: true, value: payload }, JCS_REPLAY_PAYLOAD_HASH_ALGORITHM),
				);
			}),
			{ numRuns: 500, seed: 0x0fc52026 },
		);
	});

	it("preserves the exact JSON.stringify v1 material for legacy verification", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (payload) => {
				const serialized = JSON.stringify(payload);
				expect(serializeReplayPayload(payload, LEGACY_REPLAY_PAYLOAD_HASH_ALGORITHM)).toBe(serialized);
				expect(computeReplayPayloadHash(payload, LEGACY_REPLAY_PAYLOAD_HASH_ALGORITHM)).toBe(sha256(serialized));
			}),
			{ numRuns: 500, seed: 0x0fc52026 },
		);
	});

	it("fails closed for non-JSON payloads and unknown algorithms", () => {
		expect(() => serializeReplayPayload(undefined, JCS_REPLAY_PAYLOAD_HASH_ALGORITHM)).toThrow(/canonical|JSON/i);
		expect(() => serializeReplayPayload(1n, JCS_REPLAY_PAYLOAD_HASH_ALGORITHM)).toThrow();
		expect(() => Reflect.apply(serializeReplayPayload, undefined, [{}, "untrusted-v99"])).toThrow(
			/unsupported.*algorithm/i,
		);
	});
});
