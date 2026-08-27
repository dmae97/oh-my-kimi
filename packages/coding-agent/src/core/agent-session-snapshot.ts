/**
 * Finalized-message snapshot contract.
 *
 * `SessionManager` persists replaced messages as JSON, so a replacement must be
 * a plain value that survives a JSON round-trip and cannot mutate afterwards.
 * Rather than letting a `Date`, a class instance, or a getter be silently
 * flattened at write time, this module rejects it at replacement time and
 * returns a deep-frozen deep clone.
 */

import type { AgentMessage } from "omk-agent-core";

function snapshotContractError(reason: string): Error {
	return new Error(`Finalized message replacement must be a plain serializable snapshot: ${reason}`);
}

/**
 * Clone a finalized message replacement into the JSON-compatible snapshot
 * persisted by SessionManager. Undefined remains allowed as ordinary optional
 * message data: JSON omits object properties with undefined values and writes
 * undefined array elements as null.
 */
function clonePlainSnapshot(
	value: unknown,
	ancestors = new WeakSet<object>(),
	copies = new WeakMap<object, unknown>(),
): unknown {
	if (value === null) return value;

	switch (typeof value) {
		case "string":
		case "boolean":
		case "undefined":
			return value;
		case "number":
			if (!Number.isFinite(value)) {
				throw snapshotContractError("non-finite number values are not allowed");
			}
			return value;
		case "bigint":
			throw snapshotContractError("bigint values are not allowed");
		case "function":
		case "symbol":
			throw snapshotContractError(`${typeof value} values are not allowed`);
		case "object":
			break;
		default:
			throw snapshotContractError(`${typeof value} values are not allowed`);
	}

	if (ancestors.has(value)) {
		throw snapshotContractError("cyclic values are not allowed");
	}
	if (copies.has(value)) {
		return copies.get(value);
	}
	ancestors.add(value);

	try {
		if (Array.isArray(value)) {
			const copy: unknown[] = [];
			copy.length = value.length;
			copies.set(value, copy);
			for (const key of Reflect.ownKeys(value)) {
				if (key === "length") continue;
				if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
					throw snapshotContractError("arrays may only contain indexed values");
				}
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					throw snapshotContractError("accessor or non-enumerable properties are not allowed");
				}
				copy[Number(key)] = clonePlainSnapshot(descriptor.value, ancestors, copies);
			}
			return copy;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw snapshotContractError("non-plain objects are not allowed");
		}

		const copy = Object.create(prototype) as Record<string, unknown>;
		copies.set(value, copy);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") {
				throw snapshotContractError("symbol-keyed properties are not allowed");
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw snapshotContractError("accessor or non-enumerable properties are not allowed");
			}
			Object.defineProperty(copy, key, {
				value: clonePlainSnapshot(descriptor.value, ancestors, copies),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return copy;
	} finally {
		ancestors.delete(value);
	}
}

function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
	if (value === null || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value as Record<string, unknown>)) {
		freezeSnapshot(child, seen);
	}
	return Object.freeze(value);
}

/**
 * Deep-clone and deep-freeze a finalized message, throwing when the value does
 * not satisfy the persistable-snapshot contract.
 */
export function createImmutableMessageSnapshot(message: AgentMessage): AgentMessage {
	return freezeSnapshot(clonePlainSnapshot(message) as AgentMessage);
}
