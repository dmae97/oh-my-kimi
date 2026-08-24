import { describe, expect, it } from "vitest";
import { assignDagDependencies, assignDagLevels, type ResolvedClaimEntry } from "../src/tool-dag-scheduler.ts";
import { resolutionsConflict, type ToolResourceAccess, type ToolResourceClaim } from "../src/tool-resource-claims.ts";

/**
 * `assignDagLevels` describes a barrier schedule: everything in level N+1 waits
 * for ALL of level N. `assignDagDependencies` describes the real precedence
 * graph, so a call waits only for the earlier calls it actually conflicts with.
 */

function pathClaim(key: string, access: ToolResourceAccess): ToolResourceClaim {
	return { access, kind: "path", key };
}

function entry(sourceIndex: number, claims: ToolResourceClaim[]): ResolvedClaimEntry {
	return { canonicalClaims: claims, resolution: { kind: "claims", claims }, sourceIndex };
}

function exclusiveEntry(sourceIndex: number): ResolvedClaimEntry {
	return { canonicalClaims: [], resolution: { kind: "exclusive" }, sourceIndex };
}

describe("assignDagDependencies", () => {
	it("reports no dependencies for a fully independent batch", () => {
		const entries = [
			entry(0, [pathClaim("/proj/a", "write")]),
			entry(1, [pathClaim("/proj/b", "write")]),
			entry(2, [pathClaim("/proj/c", "read")]),
		];
		expect(assignDagDependencies(entries)).toEqual([[], [], []]);
	});

	it("depends only on the actual conflicting predecessor, not the whole level", () => {
		// Under barrier levels, `read /proj/a` lands in level 1 and therefore waits
		// for BOTH level-0 calls, including the unrelated `write /proj/b`.
		const entries = [
			entry(0, [pathClaim("/proj/a", "write")]),
			entry(1, [pathClaim("/proj/b", "write")]),
			entry(2, [pathClaim("/proj/a", "read")]),
		];
		expect(assignDagLevels(entries)).toEqual([[0, 1], [2]]);
		expect(assignDagDependencies(entries)).toEqual([[], [], [0]]);
	});

	it("chains write-read-write on the same path", () => {
		const entries = [
			entry(0, [pathClaim("/proj/x", "write")]),
			entry(1, [pathClaim("/proj/x", "read")]),
			entry(2, [pathClaim("/proj/x", "write")]),
		];
		expect(assignDagDependencies(entries)).toEqual([[], [0], [0, 1]]);
	});

	it("lets concurrent reads of one path run together", () => {
		const entries = [entry(0, [pathClaim("/proj/x", "read")]), entry(1, [pathClaim("/proj/x", "read")])];
		expect(assignDagDependencies(entries)).toEqual([[], []]);
	});

	it("makes an exclusive call a full barrier in both directions", () => {
		const entries = [
			entry(0, [pathClaim("/proj/a", "read")]),
			exclusiveEntry(1),
			entry(2, [pathClaim("/proj/b", "read")]),
		];
		expect(assignDagDependencies(entries)).toEqual([[], [0], [1]]);
	});

	it("returns dependencies on earlier positions only, in ascending order", () => {
		const entries = [
			entry(0, [pathClaim("/proj/x", "write")]),
			entry(1, [pathClaim("/proj/x", "write")]),
			entry(2, [pathClaim("/proj/x", "write")]),
		];
		const deps = assignDagDependencies(entries);
		deps.forEach((list, index) => {
			expect(list).toEqual([...list].sort((a, b) => a - b));
			for (const dep of list) expect(dep).toBeLessThan(index);
		});
	});

	it("never omits a conflicting pair (randomized)", () => {
		const paths = ["/proj/a", "/proj/b", "/proj/c"];
		const accesses: ToolResourceAccess[] = ["read", "write"];
		let seed = 20260823;
		const rand = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};

		for (let trial = 0; trial < 300; trial++) {
			const size = 2 + rand(6);
			const entries: ResolvedClaimEntry[] = [];
			for (let index = 0; index < size; index++) {
				entries.push(
					rand(10) === 0
						? exclusiveEntry(index)
						: entry(index, [pathClaim(paths[rand(paths.length)], accesses[rand(accesses.length)])]),
				);
			}

			const deps = assignDagDependencies(entries);
			// Every conflicting ordered pair must be connected: the later call either
			// depends on the earlier one directly or transitively.
			const reaches = (from: number, to: number): boolean => {
				const stack = [...deps[from]];
				const seen = new Set<number>();
				while (stack.length > 0) {
					const next = stack.pop();
					if (next === undefined || seen.has(next)) continue;
					seen.add(next);
					if (next === to) return true;
					stack.push(...deps[next]);
				}
				return false;
			};
			for (let later = 0; later < size; later++) {
				for (let earlier = 0; earlier < later; earlier++) {
					if (!resolutionsConflict(entries[earlier].resolution, entries[later].resolution)) continue;
					expect(reaches(later, earlier)).toBe(true);
				}
			}
		}
	});

	it("is never slower than the barrier schedule (randomized critical path)", () => {
		// Depth of the dependency graph must not exceed the number of barrier levels.
		let seed = 7;
		const rand = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const paths = ["/proj/a", "/proj/b", "/proj/c", "/proj/d"];

		for (let trial = 0; trial < 200; trial++) {
			const size = 2 + rand(7);
			const entries: ResolvedClaimEntry[] = [];
			for (let index = 0; index < size; index++) {
				entries.push(entry(index, [pathClaim(paths[rand(paths.length)], rand(2) === 0 ? "read" : "write")]));
			}
			const deps = assignDagDependencies(entries);
			const depth = new Array<number>(size).fill(0);
			for (let index = 0; index < size; index++) {
				for (const dep of deps[index]) depth[index] = Math.max(depth[index], depth[dep] + 1);
			}
			const graphDepth = size === 0 ? 0 : Math.max(...depth) + 1;
			expect(graphDepth).toBeLessThanOrEqual(assignDagLevels(entries).length);
		}
	});
});
