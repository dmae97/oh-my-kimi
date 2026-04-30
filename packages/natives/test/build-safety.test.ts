import { describe, expect, it } from "bun:test";
import { hasAvx512Markers } from "../../../scripts/ci-release-verify-natives";
import { buildZigArgs } from "../scripts/zig-safe-wrapper";

describe("native build safety", () => {
	describe("buildZigArgs", () => {
		it("pins host zig build to the requested cpu contract", () => {
			expect(
				buildZigArgs(["build", "-Doptimize=ReleaseFast"], { target: "x86_64-linux-gnu", cpu: "x86_64_v2" }),
			).toEqual(["build", "-Doptimize=ReleaseFast", "-Dtarget=x86_64-linux-gnu", "-Dcpu=x86_64_v2"]);
		});

		it("does not override explicit zig target or cpu flags", () => {
			expect(
				buildZigArgs(["build", "-Dtarget=x86_64-linux-gnu", "-Dcpu=x86_64_v3"], {
					target: "x86_64-linux-gnu",
					cpu: "x86_64_v2",
				}),
			).toEqual(["build", "-Dtarget=x86_64-linux-gnu", "-Dcpu=x86_64_v3"]);
		});

		it("leaves non-build zig commands untouched", () => {
			expect(buildZigArgs(["version"], { target: "x86_64-linux-gnu", cpu: "x86_64_v2" })).toEqual(["version"]);
		});
	});

	describe("hasAvx512Markers", () => {
		it("flags AVX-512 register markers in disassembly", () => {
			expect(hasAvx512Markers("60ba1df:\tc4 c1 78 92 c9\t\tkmovw  %r9d,%k1")).toBe(true);
			expect(hasAvx512Markers("123456:\t62 f1 7d 48 6f c0\tvmovdqa32 %zmm0,%zmm1")).toBe(true);
		});

		it("flags EVEX-encoded AVX-512 even without zmm or mask registers", () => {
			expect(hasAvx512Markers("401000:\t62 f3 75 28 25 c2 96\tvpternlogd $0x96,%ymm2,%ymm1,%ymm0")).toBe(true);
		});

		it("ignores ordinary x86-64 disassembly", () => {
			expect(hasAvx512Markers("401000:\t48 89 e5\t\tmov %rsp,%rbp")).toBe(false);
			expect(hasAvx512Markers("401004:\tc5 f5 fe c2\tvpaddd %ymm2,%ymm1,%ymm0")).toBe(false);
			expect(hasAvx512Markers("58b83d7:\t62 00 00 00 ")).toBe(false);
		});
	});
});
