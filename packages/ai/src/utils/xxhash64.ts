/**
 * XXHash64 — pure TypeScript implementation.
 *
 * Algorithm spec: https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md
 * All arithmetic is unsigned 64-bit, enforced via `& U64` after every multiply/add.
 */

const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const U64 = 0xffffffffffffffffn;

function rol64(v: bigint, r: bigint): bigint {
	return ((v << r) | (v >> (64n - r))) & U64;
}

function round64(acc: bigint, lane: bigint): bigint {
	acc = (acc + lane * P2) & U64;
	acc = rol64(acc, 31n);
	return (acc * P1) & U64;
}

function merge64(h: bigint, acc: bigint): bigint {
	h = (h ^ round64(0n, acc)) & U64;
	return (h * P1 + P4) & U64;
}

/**
 * Compute XXHash64 of `data` with the given `seed`.
 *
 * @returns Unsigned 64-bit hash as a BigInt (always fits in 64 bits).
 */
export function xxhash64(data: Uint8Array, seed: bigint): bigint {
	const n = data.length;
	const view = new DataView(data.buffer, data.byteOffset, n);
	let p = 0;
	let h: bigint;

	if (n >= 32) {
		let v1 = (seed + P1 + P2) & U64;
		let v2 = (seed + P2) & U64;
		let v3 = seed & U64;
		let v4 = (seed - P1) & U64;

		do {
			v1 = round64(v1, view.getBigUint64(p, true));
			p += 8;
			v2 = round64(v2, view.getBigUint64(p, true));
			p += 8;
			v3 = round64(v3, view.getBigUint64(p, true));
			p += 8;
			v4 = round64(v4, view.getBigUint64(p, true));
			p += 8;
		} while (p <= n - 32);

		h = (rol64(v1, 1n) + rol64(v2, 7n) + rol64(v3, 12n) + rol64(v4, 18n)) & U64;
		h = merge64(h, v1);
		h = merge64(h, v2);
		h = merge64(h, v3);
		h = merge64(h, v4);
	} else {
		h = (seed + P5) & U64;
	}

	h = (h + BigInt(n)) & U64;

	// 8-byte tail
	for (; p <= n - 8; p += 8) {
		h = (h ^ round64(0n, view.getBigUint64(p, true))) & U64;
		h = (rol64(h, 27n) * P1 + P4) & U64;
	}
	// 4-byte tail
	if (p <= n - 4) {
		h = (h ^ ((BigInt(view.getUint32(p, true)) * P1) & U64)) & U64;
		h = (rol64(h, 23n) * P2 + P3) & U64;
		p += 4;
	}
	// 1-byte tail
	for (; p < n; p++) {
		h = (h ^ ((BigInt(data[p]) * P5) & U64)) & U64;
		h = (rol64(h, 11n) * P1) & U64;
	}

	// Avalanche
	h = ((h ^ (h >> 33n)) * P2) & U64;
	h = ((h ^ (h >> 29n)) * P3) & U64;
	return (h ^ (h >> 32n)) & U64;
}
