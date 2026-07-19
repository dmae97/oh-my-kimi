import { describe, expect, it } from "vitest";
import { computePlanKey, scheduleDagLevels } from "../src/tool-dag-scheduler.ts";
import {
	type ClaimableToolCall,
	canonicalizeClaims,
	type RegisteredToolClaimDefinition,
	resolveToolClaims,
	type ToolResourceClaim,
} from "../src/tool-resource-claims.ts";

const cwd = "/proj";
type PolicyMap = Map<string, "sequential" | "parallel">;
function schedule(
	toolCalls: ClaimableToolCall[],
	options: {
		maxConcurrency?: number;
		toolPolicies?: PolicyMap;
		registeredTools?: RegisteredToolClaimDefinition[];
		strictExtensionClaims?: boolean;
	} = {},
) {
	return scheduleDagLevels(toolCalls, { cwd, ...options });
}

/**
 * O(n) per-file safety check for the generated trace (distinct files only).
 * A level is safe when no path resource is touched by a write together with any
 * other access, and no multi-member level holds an exclusive call. Path
 * aliasing is covered by the small targeted tests above.
 */
function assertLevelsSafe(calls: ClaimableToolCall[], levels: number[][], context?: string): void {
	const resolutions = calls.map((call) => resolveToolClaims(call, { cwd }));
	for (const level of levels) {
		if (level.length > 1) {
			for (const index of level) {
				expect(resolutions[index].kind, context).toBe("claims");
			}
		}
		const byFile = new Map<string, { write: boolean; count: number }>();
		for (const index of level) {
			const resolution = resolutions[index];
			if (resolution.kind !== "claims") {
				continue;
			}
			for (const claim of resolution.claims) {
				if (claim.kind !== "path") {
					continue;
				}
				const entry = byFile.get(claim.key) ?? { write: false, count: 0 };
				if (claim.access === "write") {
					entry.write = true;
				}
				entry.count += 1;
				byFile.set(claim.key, entry);
			}
		}
		for (const entry of byFile.values()) {
			expect(entry.write && entry.count > 1, context).toBe(false);
		}
	}
}

/** Assert the plan covers every source index exactly once. */
function assertCoversAllOnce(levels: number[][], count: number, context?: string): void {
	const seen = levels.flat().sort((a, b) => a - b);
	expect(seen, context).toEqual(Array.from({ length: count }, (_, index) => index));
}

describe("scheduleDagLevels stability and plan key", () => {
	it("is stable under equal inputs", async () => {
		const calls = [
			{ name: "write", arguments: { path: "x" } },
			{ name: "write", arguments: { path: "x" } },
			{ name: "write", arguments: { path: "y" } },
		];
		const a = await schedule(calls);
		const b = await schedule(calls);
		expect(a.levels).toEqual(b.levels);
		expect(a.planKey).toBe(b.planKey);
	});

	it("keeps normalized custom-relative plans deterministic", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "custom_write",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "write" }],
			},
		];
		const calls = [
			{ name: "custom_write", arguments: {} },
			{ name: "read", arguments: { path: "/proj/a.ts" } },
		];
		const a = await schedule(calls, { registeredTools });
		const b = await schedule(calls, { registeredTools });

		expect(a.levels).toEqual([[0], [1]]);
		expect(b.levels).toEqual(a.levels);
		expect(b.planKey).toBe(a.planKey);
	});

	it("distinct inputs produce distinct plan keys", async () => {
		const keyA = (await schedule([{ name: "write", arguments: { path: "x" } }])).planKey;
		const keyB = (await schedule([{ name: "write", arguments: { path: "y" } }])).planKey;
		const keyC = (await schedule([{ name: "read", arguments: { path: "x" } }])).planKey;
		expect(keyA).not.toBe(keyB);
		expect(keyA).not.toBe(keyC);
		expect(keyB).not.toBe(keyC);
	});

	it("plan key never includes execution timing or outcomes", async () => {
		const key = (await schedule([{ name: "write", arguments: { path: "x" } }])).planKey;
		expect(key).not.toMatch(/\d{10,}/);
		expect(key.toLowerCase()).not.toContain("success");
		expect(key.toLowerCase()).not.toContain("error");
	});

	it("does not change the plan key when a call's claims are reordered", () => {
		const claims: ToolResourceClaim[] = [
			{ access: "write", kind: "path", key: "/x" },
			{ access: "read", kind: "path", key: "/y" },
		];
		const keyOf = (list: ToolResourceClaim[]) =>
			computePlanKey([
				{
					sourceIndex: 0,
					resolution: { kind: "claims", claims: list },
					canonicalClaims: canonicalizeClaims(list),
				},
			]);
		expect(keyOf(claims)).toBe(keyOf([claims[1], claims[0]]));
	});
});

describe("scheduleDagLevels determinism across seeded bounded schedules", () => {
	const traceSeed = 0x5eed1234;
	const scheduleCount = 10_000;
	const maxCalls = 32;

	// Deterministic LCG so every schedule is reproducible (no crypto/random).
	function makeLcg(seed: number) {
		let state = seed >>> 0;
		return () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state / 0x100000000;
		};
	}

	function generate(n: number, seed: number): ClaimableToolCall[] {
		const rand = makeLcg(seed);
		const files = Array.from({ length: maxCalls }, (_, i) => `f${i}.ts`);
		const calls: ClaimableToolCall[] = [];
		for (let i = 0; i < n; i++) {
			const roll = rand();
			const file = files[Math.floor(rand() * files.length)];
			if (roll < 0.45) {
				calls.push({ name: "read", arguments: { path: file } });
			} else if (roll < 0.8) {
				calls.push({ name: "write", arguments: { path: file } });
			} else if (roll < 0.9) {
				calls.push({ name: "bash", arguments: { command: "ls" } });
			} else if (roll < 0.95) {
				calls.push({ name: "grep", arguments: { pattern: "x" } });
			} else {
				calls.push({ name: "custom_tool", arguments: {} });
			}
		}
		return calls;
	}

	it(`produces safe, total, deterministic capped plans for 10000 schedules from seed ${traceSeed}`, async () => {
		for (let scheduleIndex = 0; scheduleIndex < scheduleCount; scheduleIndex++) {
			const seed = (traceSeed + scheduleIndex) >>> 0;
			const calls = generate((scheduleIndex % maxCalls) + 1, seed);
			const maxConcurrency = (seed % 8) + 1;
			const context = `trace seed ${traceSeed}, schedule ${scheduleIndex}, schedule seed ${seed}`;
			const plan = await scheduleDagLevels(calls, { cwd, maxConcurrency });
			const again = await scheduleDagLevels(calls, { cwd, maxConcurrency });

			assertCoversAllOnce(plan.levels, calls.length, context);
			assertLevelsSafe(calls, plan.levels, context);
			expect(Math.max(...plan.levels.map((level) => level.length)), context).toBeLessThanOrEqual(maxConcurrency);
			expect(again.levels, context).toEqual(plan.levels);
			expect(again.planKey, context).toBe(plan.planKey);
		}
	});

	it("plans an explicit bounded batch of 32 calls", async () => {
		const calls = generate(maxCalls, traceSeed);
		const plan = await scheduleDagLevels(calls, { cwd });

		expect(calls).toHaveLength(32);
		assertCoversAllOnce(plan.levels, calls.length);
		assertLevelsSafe(calls, plan.levels);
	});
});
