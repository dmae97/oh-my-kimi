import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { ReplayPayloadHashAlgorithm } from "../types/evidence.ts";

export const LEGACY_REPLAY_PAYLOAD_HASH_ALGORITHM = "json-stringify-v1" as const;
export const JCS_REPLAY_PAYLOAD_HASH_ALGORITHM = "jcs-rfc8785-v2" as const;

export function serializeReplayPayload(payload: unknown, algorithm: ReplayPayloadHashAlgorithm): string {
	let serialized: string | undefined;
	if (algorithm === LEGACY_REPLAY_PAYLOAD_HASH_ALGORITHM) {
		serialized = JSON.stringify(payload);
	} else if (algorithm === JCS_REPLAY_PAYLOAD_HASH_ALGORITHM) {
		serialized = canonicalize(payload);
	} else {
		throw new TypeError(`Unsupported replay payload hash algorithm: ${String(algorithm)}`);
	}
	if (serialized === undefined) {
		throw new TypeError(`Replay payload is not valid JSON for ${algorithm}`);
	}
	return serialized;
}

export function computeReplayPayloadHash(payload: unknown, algorithm: ReplayPayloadHashAlgorithm): string {
	return createHash("sha256").update(serializeReplayPayload(payload, algorithm)).digest("hex");
}
