function assertPlainData(value: unknown, jsonOnly: boolean, ancestors = new WeakSet<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new TypeError("Non-finite numbers are not supported data values");
	}
	if (value === undefined && !jsonOnly) return;
	if (typeof value !== "object") throw new TypeError("Unsupported non-data value");
	if (ancestors.has(value)) throw new TypeError("Cyclic data values are not supported");
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Unsupported data object prototype");
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (prototype !== Array.prototype || Object.keys(value).length !== value.length) {
				throw new TypeError("Sparse or extended arrays are not supported data values");
			}
			for (const item of value) assertPlainData(item, jsonOnly, ancestors);
			return;
		}
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
				throw new TypeError("Symbol, hidden, and accessor properties are not supported data values");
			}
			assertPlainData(descriptor.value, jsonOnly, ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

function freezePlainData(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	for (const key of Reflect.ownKeys(value)) freezePlainData(Reflect.get(value, key));
	Object.freeze(value);
}

/** Parse a detached mutable JSON-domain value, rejecting every unsupported shape. */
export function parseJsonValue<T>(value: T): T {
	assertPlainData(value, true);
	const snapshot = structuredClone(value);
	// Cloning restores masked intrinsic prototypes (Map, views, buffers, etc.).
	assertPlainData(snapshot, true);
	return snapshot;
}

/** Clone a plain-data payload, then recursively freeze its executor-owned graph. */
export function createImmutableSnapshot<T>(value: T): T {
	assertPlainData(value, false);
	const snapshot = structuredClone(value);
	assertPlainData(snapshot, false);
	freezePlainData(snapshot);
	return snapshot;
}

/** Parse and freeze a detached JSON-domain value. */
export function createImmutableJsonSnapshot<T>(value: T): T {
	const snapshot = parseJsonValue(value);
	freezePlainData(snapshot);
	return snapshot;
}
