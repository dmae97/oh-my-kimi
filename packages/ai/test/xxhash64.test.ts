import { describe, expect, it } from "bun:test";
import { xxhash64 } from "@oh-my-pi/pi-ai/utils/xxhash64";

const enc = new TextEncoder();

// Seed used by the Bun-anthropic HTTP layer for cch attestation.
const CCH_SEED = 0x4d659218e32a3268n;

describe("xxhash64", () => {
	it("matches spec test vectors (seed=0)", () => {
		// Official xxHash specification vectors.
		expect(xxhash64(new Uint8Array(0), 0n)).toBe(0xef46db3751d8e999n);
		expect(xxhash64(enc.encode("a"), 0n)).toBe(0xd24ec4f1a98c6e5bn);
	});

	it("is sensitive to seed", () => {
		const data = enc.encode("hello");
		expect(xxhash64(data, 0n)).not.toBe(xxhash64(data, 1n));
	});

	it("cch attestation: known (body-with-placeholder, low-20-bit hash) pairs", () => {
		// Each body contains "cch=00000" as the Bun HTTP layer sees it before patching.
		// Expected values precomputed with the Python xxhash reference.
		const cases: [string, string][] = [
			["cch=00000", "a47f7"],
			['{"messages":[],"cch=00000","x":1}', "3073d"],
			[
				"x-anthropic-billing-header: cc_version=2.1.148; cc_entrypoint=cli; cch=00000;",
				"792eb",
			],
		];

		for (const [body, expected] of cases) {
			const h = xxhash64(enc.encode(body), CCH_SEED);
			expect((h & 0xfffffn).toString(16).padStart(5, "0")).toBe(expected);
		}
	});
});
