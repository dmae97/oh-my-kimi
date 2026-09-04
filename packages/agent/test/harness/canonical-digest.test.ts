import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson, domainDigest, sha256Hex } from "../../src/harness/canonical-digest.ts";

function nodeSha256(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

describe("sha256Hex", () => {
	it("matches the FIPS 180-4 reference vectors", () => {
		expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
			"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
		);
	});

	it("handles the padding boundaries around one block (55, 56, 63, 64, 65 bytes)", () => {
		for (const length of [55, 56, 63, 64, 65, 119, 120, 128]) {
			const input = "a".repeat(length);
			expect(sha256Hex(input)).toBe(nodeSha256(input));
		}
	});

	it("agrees with node:crypto on arbitrary bytes and unicode strings", () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 600 }), (bytes) => {
				expect(sha256Hex(bytes)).toBe(nodeSha256(bytes));
			}),
			{ numRuns: 300, seed: 0x5a256001 },
		);
		fc.assert(
			fc.property(fc.string({ maxLength: 300, unit: "grapheme" }), (text) => {
				expect(sha256Hex(text)).toBe(nodeSha256(text));
			}),
			{ numRuns: 300, seed: 0x5a256002 },
		);
	});
});

describe("canonicalJson", () => {
	it("sorts object keys by UTF-16 code unit and omits undefined properties", () => {
		expect(canonicalJson({ b: 1, a: [true, null, "x"], z: undefined, "\u00e9": 2, Z: 3 })).toBe(
			'{"Z":3,"a":[true,null,"x"],"b":1,"\u00e9":2}',
		);
	});

	it("is invariant under key insertion order", () => {
		fc.assert(
			fc.property(fc.dictionary(fc.string(), fc.integer()), (record) => {
				const entries = Object.entries(record);
				const reversed = Object.fromEntries([...entries].reverse());
				expect(canonicalJson(reversed)).toBe(canonicalJson(record));
			}),
			{ numRuns: 200, seed: 0x0c4a0905 },
		);
	});

	it("round-trips through JSON.parse to the same value standard JSON yields", () => {
		// RFC 8785 serializes numbers with ES ToString, so `-0` canonicalizes to `0`
		// exactly as JSON.stringify does; the oracle is the standard round trip.
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
			}),
			{ numRuns: 300, seed: 0x0c4a0904 },
		);
		expect(canonicalJson(-0)).toBe("0");
		expect(canonicalJson({ z: [-0, 1e21, 1e-7] })).toBe('{"z":[0,1e+21,1e-7]}');
	});

	it("rejects values a digest could not commit to", () => {
		expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
		expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
		expect(() => canonicalJson(10n)).toThrow(TypeError);
		expect(() => canonicalJson(() => 1)).toThrow(TypeError);
		expect(() => canonicalJson(Symbol("s"))).toThrow(TypeError);
		expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
		expect(() => canonicalJson(new Map())).toThrow(TypeError);
		expect(() => canonicalJson([undefined])).toThrow(TypeError);
		expect(() => canonicalJson(undefined)).toThrow(TypeError);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
	});

	it("accepts null-prototype objects and nested plain structures", () => {
		const bare = Object.create(null) as Record<string, unknown>;
		bare.k = { nested: [1, { deep: "v" }] };
		expect(canonicalJson(bare)).toBe('{"k":{"nested":[1,{"deep":"v"}]}}');
	});
});

describe("domainDigest", () => {
	it("separates domains and part boundaries", () => {
		expect(domainDigest("omk.a", ["x"])).not.toBe(domainDigest("omk.b", ["x"]));
		expect(domainDigest("omk.a", ["ab", "c"])).not.toBe(domainDigest("omk.a", ["a", "bc"]));
		expect(domainDigest("omk.a", ["ab", "c"])).toBe(domainDigest("omk.a", ["ab", "c"]));
	});

	it("rejects an empty domain", () => {
		expect(() => domainDigest("", ["x"])).toThrow(TypeError);
	});

	it("canonicalDigest equals sha256 of the canonical text", () => {
		const value = { z: [1, 2], a: "s" };
		expect(canonicalDigest(value)).toBe(nodeSha256(canonicalJson(value)));
	});
});
