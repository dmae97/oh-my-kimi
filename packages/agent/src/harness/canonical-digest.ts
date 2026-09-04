/**
 * Browser-safe canonical serialization and SHA-256 for harness identities.
 *
 * Every digest the harness binds to an operation, attempt, effect, or trace
 * must be reproducible from the same logical value on any host, so this module
 * fixes two things and imports nothing:
 *
 * 1. `canonicalJson` — a JCS-style (RFC 8785) serialization: object keys sorted
 *    by UTF-16 code unit, no whitespace, ES number formatting, `undefined`
 *    properties omitted. Non-finite numbers, bigint, functions, symbols, and
 *    non-plain objects are rejected instead of silently coerced, because a
 *    digest over a lossy encoding is not a commitment to the value.
 * 2. `sha256Hex` — a synchronous pure-TypeScript SHA-256, so pure reducers can
 *    derive identities without an async `crypto.subtle` round trip or a Node
 *    `node:crypto` import that the browser entry point cannot carry.
 *
 * `domainDigest` adds domain separation: the same parts hashed under two
 * domains never collide, and a part list is length-delimited through the
 * canonical encoding so `["ab","c"]` and `["a","bc"]` differ.
 */

export function canonicalJson(value: unknown): string {
	return serialize(value, new WeakSet<object>());
}

function serialize(value: unknown, ancestors: WeakSet<object>): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite numbers are not representable");
			return JSON.stringify(value);
		case "object":
			break;
		default:
			throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
	}
	const object = value as object;
	if (ancestors.has(object)) throw new TypeError("canonicalJson: cyclic values are not representable");
	ancestors.add(object);
	try {
		if (Array.isArray(object)) {
			const items = object.map((item) => {
				if (item === undefined)
					throw new TypeError("canonicalJson: undefined array elements are not representable");
				return serialize(item, ancestors);
			});
			return `[${items.join(",")}]`;
		}
		const prototype = Object.getPrototypeOf(object);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("canonicalJson: only plain objects are representable");
		}
		const record = object as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort(compareCodeUnits);
		const members = keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`);
		return `{${members.join(",")}}`;
	} finally {
		ancestors.delete(object);
	}
}

/** RFC 8785 orders keys by UTF-16 code unit, which is what `<` gives on JS strings. */
function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

const ROUND_CONSTANTS = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2,
]);

const INITIAL_STATE = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotateRight(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

/** Pad the message per FIPS 180-4 §5.1.1: 0x80, zeros, then the 64-bit big-endian bit length. */
function padMessage(bytes: Uint8Array): DataView {
	const bitLength = bytes.length * 8;
	const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
	view.setUint32(paddedLength - 4, bitLength >>> 0, false);
	return view;
}

function compressBlock(state: Uint32Array, schedule: Uint32Array, view: DataView, offset: number): void {
	for (let index = 0; index < 16; index++) schedule[index] = view.getUint32(offset + index * 4, false);
	for (let index = 16; index < 64; index++) {
		const w15 = schedule[index - 15];
		const w2 = schedule[index - 2];
		const sigma0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
		const sigma1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
		schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
	}
	let [a, b, c, d, e, f, g, h] = state;
	for (let index = 0; index < 64; index++) {
		const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
		const choose = (e & f) ^ (~e & g);
		const temp1 = (h + bigSigma1 + choose + ROUND_CONSTANTS[index] + schedule[index]) >>> 0;
		const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
		const majority = (a & b) ^ (a & c) ^ (b & c);
		const temp2 = (bigSigma0 + majority) >>> 0;
		h = g;
		g = f;
		f = e;
		e = (d + temp1) >>> 0;
		d = c;
		c = b;
		b = a;
		a = (temp1 + temp2) >>> 0;
	}
	state[0] = (state[0] + a) >>> 0;
	state[1] = (state[1] + b) >>> 0;
	state[2] = (state[2] + c) >>> 0;
	state[3] = (state[3] + d) >>> 0;
	state[4] = (state[4] + e) >>> 0;
	state[5] = (state[5] + f) >>> 0;
	state[6] = (state[6] + g) >>> 0;
	state[7] = (state[7] + h) >>> 0;
}

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. Synchronous and dependency-free. */
export function sha256Hex(input: string | Uint8Array): string {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const view = padMessage(bytes);
	const state = new Uint32Array(INITIAL_STATE);
	const schedule = new Uint32Array(64);
	for (let offset = 0; offset < view.byteLength; offset += 64) compressBlock(state, schedule, view, offset);
	let hex = "";
	for (const word of state) hex += word.toString(16).padStart(8, "0");
	return hex;
}

/** SHA-256 of the canonical JSON encoding of `value`. */
export function canonicalDigest(value: unknown): string {
	return sha256Hex(canonicalJson(value));
}

/**
 * Domain-separated digest over an ordered part list. The parts are committed
 * through canonical JSON, so boundaries between parts are unambiguous and a
 * different domain string always yields a different digest.
 */
export function domainDigest(domain: string, parts: readonly string[]): string {
	if (domain.length === 0) throw new TypeError("domainDigest: domain must be non-empty");
	return sha256Hex(canonicalJson({ domain, parts }));
}
