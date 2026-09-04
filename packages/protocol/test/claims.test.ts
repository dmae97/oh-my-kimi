import { describe, expect, it } from "vitest";
import {
	CLAIM_GRAPH_SCHEMA_VERSION,
	type ClaimGraph,
	ClaimGraphError,
	type ClaimNode,
	canonicalClaimGraph,
	evaluateProofClosure,
	type ObservationNode,
	type ProofClosureInput,
	type ProofClosureResult,
	rootClaimIds,
	topologicalClaimOrder,
	type WaiverNode,
} from "../src/index.ts";

const NOW = "2026-09-04T12:00:00.000Z";
const LATER = "2026-09-05T00:00:00.000Z";
const EARLIER = "2026-09-04T00:00:00.000Z";
const ROOT = "sha256:root";
const ENV = "sha256:env";

function claim(claimId: string, inputs: readonly string[] = [], patch: Partial<ClaimNode> = {}): ClaimNode {
	return {
		claimId,
		kind: "requirement",
		statement: `claim ${claimId}`,
		severity: "required",
		satisfaction: { rule: "all", inputs },
		trustFloor: "deterministic_validator",
		invalidationKeys: [],
		...patch,
	};
}

function graph(...claims: ClaimNode[]): ClaimGraph {
	return { schemaVersion: CLAIM_GRAPH_SCHEMA_VERSION, claims };
}

function supports(
	observationId: string,
	claimIds: readonly string[],
	patch: Partial<ObservationNode> = {},
): ObservationNode {
	return {
		observationId,
		claimIds,
		polarity: "supports",
		source: "deterministic_validator",
		sourceRoot: ROOT,
		environmentDigest: ENV,
		...patch,
	};
}

function input(patch: Partial<ProofClosureInput> & { graph: ClaimGraph }): ProofClosureInput {
	return {
		observations: [],
		waivers: [],
		sourceRoot: ROOT,
		environmentDigest: ENV,
		workspaceCompleteness: "complete",
		unresolvedEffectIds: [],
		now: NOW,
		...patch,
	};
}

/** The plan's §5.7 example: release.ready -> tests.all -> {unit, integration, windows}, plus package and workspace. */
const RELEASE = graph(
	claim("release.ready", ["tests.all", "package.integrity", "workspace.complete"]),
	claim("tests.all", ["unit.pass", "integration.pass", "windows.pass"]),
	claim("unit.pass"),
	claim("integration.pass"),
	claim("windows.pass"),
	claim("package.integrity"),
	claim("workspace.complete", [], { scopeSensitive: true }),
);
const RELEASE_LEAVES = ["unit.pass", "integration.pass", "windows.pass", "package.integrity", "workspace.complete"];

function verdictOf(result: ProofClosureResult, claimId: string): string {
	const evaluation = result.claimEvaluations.find((item) => item.claimId === claimId);
	if (evaluation === undefined) throw new Error(`no evaluation for ${claimId}`);
	return evaluation.verdict;
}

describe("claim graph structure", () => {
	it("rejects cycles, self references, duplicates, unknown inputs, and bad schemas", () => {
		expect(() => evaluateProofClosure(input({ graph: graph(claim("a", ["b"]), claim("b", ["a"])) }))).toThrow(
			expect.objectContaining({ code: "cycle" }),
		);
		expect(() => evaluateProofClosure(input({ graph: graph(claim("a", ["a"])) }))).toThrow(
			expect.objectContaining({ code: "cycle" }),
		);
		expect(() => evaluateProofClosure(input({ graph: graph(claim("a"), claim("a")) }))).toThrow(
			expect.objectContaining({ code: "duplicate_claim" }),
		);
		expect(() => evaluateProofClosure(input({ graph: graph(claim("a", ["ghost"])) }))).toThrow(
			expect.objectContaining({ code: "unknown_input" }),
		);
		expect(() =>
			evaluateProofClosure(input({ graph: { ...graph(claim("a")), schemaVersion: "omk.claim-graph.v0" as never } })),
		).toThrow(ClaimGraphError);
		expect(() => evaluateProofClosure(input({ graph: graph(claim("a")), now: "yesterday" }))).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(() => evaluateProofClosure(input({ graph: graph(claim("a", [], { requiredWitnesses: 0 })) }))).toThrow(
			expect.objectContaining({ code: "invalid_claim" }),
		);
	});

	it("orders children before parents deterministically and exposes roots", () => {
		const order = topologicalClaimOrder(RELEASE).map((node) => node.claimId);
		expect(order.indexOf("unit.pass")).toBeLessThan(order.indexOf("tests.all"));
		expect(order.indexOf("tests.all")).toBeLessThan(order.indexOf("release.ready"));
		expect(order[order.length - 1]).toBe("release.ready");
		expect(rootClaimIds(RELEASE)).toEqual(["release.ready"]);
		const reversed = graph(...[...RELEASE.claims].reverse());
		expect(topologicalClaimOrder(reversed).map((node) => node.claimId)).toEqual(order);
	});

	it("canonical form is invariant under claim and input permutation", () => {
		const shuffled = graph(
			...[...RELEASE.claims].reverse().map((node) => ({
				...node,
				satisfaction: { ...node.satisfaction, inputs: [...node.satisfaction.inputs].reverse() },
			})),
		);
		expect(JSON.stringify(canonicalClaimGraph(shuffled))).toBe(JSON.stringify(canonicalClaimGraph(RELEASE)));
	});
});

describe("proof closure", () => {
	it("verifies the release graph when every leaf has a qualified witness", () => {
		const result = evaluateProofClosure(
			input({ graph: RELEASE, observations: RELEASE_LEAVES.map((id) => supports(`obs-${id}`, [id])) }),
		);
		expect(result.verdict).toBe("verified");
		expect(result.blockingClaimIds).toEqual([]);
		expect(result.minimalBlockingCut).toEqual([]);
		expect(verdictOf(result, "release.ready")).toBe("satisfied");
	});

	it("reports the minimal blocking cut, not every intermediate claim", () => {
		const observations = RELEASE_LEAVES.filter((id) => id !== "windows.pass" && id !== "workspace.complete").map(
			(id) => supports(`obs-${id}`, [id]),
		);
		const result = evaluateProofClosure(input({ graph: RELEASE, observations }));
		expect(result.verdict).toBe("inconclusive");
		expect(result.minimalBlockingCut).toEqual(["windows.pass", "workspace.complete"]);
		expect(result.blockingClaimIds).toEqual(["release.ready", "tests.all", "windows.pass", "workspace.complete"]);
	});

	it("lets a counterexample override every positive witness and the global verdict", () => {
		const observations = [
			...RELEASE_LEAVES.map((id) => supports(`obs-${id}`, [id])),
			supports("cx", ["unit.pass"], { polarity: "violates", source: "model_narrative" }),
		];
		const result = evaluateProofClosure(input({ graph: RELEASE, observations }));
		expect(result.verdict).toBe("violated");
		expect(verdictOf(result, "unit.pass")).toBe("violated");
		expect(verdictOf(result, "tests.all")).toBe("violated");
		expect(verdictOf(result, "release.ready")).toBe("violated");
		expect(result.minimalBlockingCut).toEqual(["unit.pass"]);
	});

	it("drops observations from another source root or environment", () => {
		const leaf = graph(claim("a"));
		expect(
			evaluateProofClosure(input({ graph: leaf, observations: [supports("o", ["a"], { sourceRoot: "other" })] }))
				.verdict,
		).toBe("inconclusive");
		const wrongEnv = evaluateProofClosure(
			input({ graph: leaf, observations: [supports("o", ["a"], { environmentDigest: "other" })] }),
		);
		expect(verdictOf(wrongEnv, "a")).toBe("missing");
	});

	it("classifies expired and key-mismatched witnesses as stale", () => {
		const keyed = graph(claim("a", [], { invalidationKeys: ["lockfile"] }));
		const expired = evaluateProofClosure(
			input({
				graph: keyed,
				observations: [supports("o", ["a"], { validUntil: EARLIER, invalidationKeys: ["lockfile"] })],
			}),
		);
		expect(verdictOf(expired, "a")).toBe("stale");
		const missingKey = evaluateProofClosure(input({ graph: keyed, observations: [supports("o", ["a"])] }));
		expect(verdictOf(missingKey, "a")).toBe("stale");
		const fresh = evaluateProofClosure(
			input({
				graph: keyed,
				observations: [supports("o", ["a"], { validUntil: LATER, invalidationKeys: ["lockfile", "x"] })],
			}),
		);
		expect(fresh.verdict).toBe("verified");
	});

	it("enforces the trust floor and independent witness counts", () => {
		const strict = graph(claim("a", [], { requiredWitnesses: 2 }));
		const lowTrust = evaluateProofClosure(
			input({ graph: strict, observations: [supports("o", ["a"], { source: "self_review" })] }),
		);
		expect(verdictOf(lowTrust, "a")).toBe("insufficient_trust");
		const correlated = evaluateProofClosure(
			input({
				graph: strict,
				observations: [
					supports("o1", ["a"], { independenceGroup: "tsc" }),
					supports("o2", ["a"], { independenceGroup: "tsc" }),
				],
			}),
		);
		expect(verdictOf(correlated, "a")).toBe("missing");
		const independent = evaluateProofClosure(
			input({
				graph: strict,
				observations: [
					supports("o1", ["a"], { independenceGroup: "tsc" }),
					supports("o2", ["a"], { independenceGroup: "vitest" }),
				],
			}),
		);
		expect(independent.verdict).toBe("verified");
		expect(verdictOf(independent, "a")).toBe("satisfied");
	});

	it("blocks scope-sensitive claims and the global closure on an incomplete workspace", () => {
		const observations = RELEASE_LEAVES.map((id) => supports(`obs-${id}`, [id]));
		const result = evaluateProofClosure(
			input({ graph: RELEASE, observations, workspaceCompleteness: "partial_excluded" }),
		);
		expect(result.verdict).toBe("inconclusive");
		expect(verdictOf(result, "workspace.complete")).toBe("incomplete_scope");
		expect(verdictOf(result, "unit.pass")).toBe("satisfied");
		expect(result.minimalBlockingCut).toEqual(["workspace.complete"]);
	});

	it("blocks the global closure on an unresolved effect even when every claim is satisfied", () => {
		const observations = RELEASE_LEAVES.map((id) => supports(`obs-${id}`, [id]));
		const result = evaluateProofClosure(
			input({ graph: RELEASE, observations, unresolvedEffectIds: ["eff-2", "eff-1"] }),
		);
		expect(result.verdict).toBe("inconclusive");
		expect(result.blockingClaimIds).toEqual([]);
		expect(result.unresolvedEffectIds).toEqual(["eff-1", "eff-2"]);
	});

	it("applies a valid waiver to an unclosed claim but never to a violation", () => {
		const waiver: WaiverNode = {
			waiverId: "w1",
			claimId: "windows.pass",
			issuer: "release-owner",
			reason: "no windows runner today",
			sourceRoot: ROOT,
			expiresAt: LATER,
		};
		const observations = RELEASE_LEAVES.filter((id) => id !== "windows.pass").map((id) =>
			supports(`obs-${id}`, [id]),
		);
		const waived = evaluateProofClosure(input({ graph: RELEASE, observations, waivers: [waiver] }));
		expect(waived.verdict).toBe("verified");
		expect(waived.claimEvaluations.find((item) => item.claimId === "windows.pass")).toMatchObject({
			verdict: "waived",
			waiverId: "w1",
		});
		const expired = evaluateProofClosure(
			input({ graph: RELEASE, observations, waivers: [{ ...waiver, expiresAt: EARLIER }] }),
		);
		expect(expired.verdict).toBe("inconclusive");
		const foreign = evaluateProofClosure(
			input({ graph: RELEASE, observations, waivers: [{ ...waiver, sourceRoot: "other" }] }),
		);
		expect(foreign.verdict).toBe("inconclusive");
		const violated = evaluateProofClosure(
			input({
				graph: RELEASE,
				observations: [...observations, supports("cx", ["windows.pass"], { polarity: "violates" })],
				waivers: [waiver],
			}),
		);
		expect(violated.verdict).toBe("violated");
		expect(verdictOf(violated, "windows.pass")).toBe("violated");
		expect(() => evaluateProofClosure(input({ graph: RELEASE, waivers: [{ ...waiver, claimId: "ghost" }] }))).toThrow(
			expect.objectContaining({ code: "unknown_input" }),
		);
	});

	it("evaluates any-rules by the best child and picks the cheapest branch for the cut", () => {
		const either = graph(
			claim("root", ["fast", "slow"], { satisfaction: { rule: "any", inputs: ["fast", "slow"] } }),
			claim("fast", ["f1", "f2"]),
			claim("slow", ["s1"]),
			claim("f1"),
			claim("f2"),
			claim("s1"),
		);
		const none = evaluateProofClosure(input({ graph: either }));
		expect(none.verdict).toBe("inconclusive");
		expect(none.minimalBlockingCut).toEqual(["s1"]);
		// Closing one branch closes the root; the untaken branch's required leaves block nothing.
		const viaFast = evaluateProofClosure(
			input({ graph: either, observations: [supports("a", ["f1"]), supports("b", ["f2"])] }),
		);
		expect(viaFast.verdict).toBe("verified");
		expect(viaFast.blockingClaimIds).toEqual([]);
		expect(verdictOf(viaFast, "s1")).toBe("missing");
		// A violated branch does not violate an any-root while another branch can still close it.
		const violatedBranch = evaluateProofClosure(
			input({ graph: either, observations: [supports("cx", ["s1"], { polarity: "violates" })] }),
		);
		expect(verdictOf(violatedBranch, "slow")).toBe("violated");
		expect(verdictOf(violatedBranch, "root")).toBe("missing");
		expect(violatedBranch.verdict).toBe("inconclusive");
		expect(violatedBranch.minimalBlockingCut).toEqual(["s1"]);
	});

	it("advisory claims never block, never fold into a parent, and alone leave a graph unverified", () => {
		expect(evaluateProofClosure(input({ graph: graph(claim("style", [], { severity: "advisory" })) })).verdict).toBe(
			"unverified",
		);
		const mixed = graph(
			claim("ship", ["must", "style"]),
			claim("must"),
			claim("style", [], { severity: "advisory" }),
		);
		const result = evaluateProofClosure(input({ graph: mixed, observations: [supports("o", ["must"])] }));
		expect(result.verdict).toBe("verified");
		expect(verdictOf(result, "style")).toBe("missing");
		expect(verdictOf(result, "ship")).toBe("satisfied");
		expect(result.blockingClaimIds).toEqual([]);
		// A composite whose only children are advisory is witnessed like a leaf.
		const onlyAdvisory = graph(claim("ship", ["style"]), claim("style", [], { severity: "advisory" }));
		expect(verdictOf(evaluateProofClosure(input({ graph: onlyAdvisory })), "ship")).toBe("missing");
		expect(
			evaluateProofClosure(input({ graph: onlyAdvisory, observations: [supports("o", ["ship"])] })).verdict,
		).toBe("verified");
	});
});

/** Deterministic xorshift32 so the property suite needs no generator dependency and replays by seed. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0 || 0x9e3779b9;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0x100000000;
	};
}

/** Random layered DAGs: each claim may depend only on claims from the previous layer, so the graph is acyclic. */
function randomGraph(next: () => number): ClaimGraph {
	const nodes: ClaimNode[] = [];
	const layerCount = 1 + Math.floor(next() * 4);
	for (let depth = 0; depth < layerCount; depth++) {
		const width = 1 + Math.floor(next() * 3);
		const previous = nodes.filter((node) => node.claimId.startsWith(`c${depth - 1}-`)).map((node) => node.claimId);
		for (let position = 0; position < width; position++) {
			const inputs = previous.slice(0, Math.floor(next() * (previous.length + 1)));
			const rule = next() < 0.5 ? "all" : "any";
			const severity = next() < 0.8 ? "required" : "advisory";
			nodes.push(claim(`c${depth}-${position}`, inputs, { satisfaction: { rule, inputs }, severity }));
		}
	}
	return graph(...nodes);
}

function randomObservations(next: () => number, graphValue: ClaimGraph): ObservationNode[] {
	const ids = graphValue.claims.map((node) => node.claimId);
	const count = Math.floor(next() * 9);
	const observations: ObservationNode[] = [];
	for (let index = 0; index < count; index++) {
		const target = ids[Math.floor(next() * ids.length)];
		const polarity = next() < 0.25 ? "violates" : "supports";
		const source = next() < 0.5 ? "deterministic_validator" : "self_review";
		observations.push(supports(`o${index}`, [target], { polarity, source }));
	}
	return observations;
}

describe("proof closure (property)", () => {
	it("is deterministic under permutation and never verifies with a blocker, unresolved effect, or partial scope", () => {
		const next = seededRandom(0x5eed0904);
		for (let run = 0; run < 400; run++) {
			const graphValue = randomGraph(next);
			const observations = randomObservations(next, graphValue);
			const completeness = next() < 0.7 ? "complete" : "partial_excluded";
			const unresolved = next() < 0.8 ? [] : ["eff-1"];
			const base = input({
				graph: graphValue,
				observations,
				workspaceCompleteness: completeness,
				unresolvedEffectIds: unresolved,
			});
			const result = evaluateProofClosure(base);
			const permuted = evaluateProofClosure({
				...base,
				graph: graph(...[...graphValue.claims].reverse()),
				observations: [...observations].reverse(),
			});
			const byId = (items: readonly { claimId: string }[]) =>
				[...items].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
			expect(permuted.verdict, `run ${run}`).toBe(result.verdict);
			expect(byId(permuted.claimEvaluations)).toEqual(byId(result.claimEvaluations));
			expect(permuted.minimalBlockingCut).toEqual(result.minimalBlockingCut);
			const roots = rootClaimIds(graphValue)
				.map((id) => result.claimEvaluations.find((item) => item.claimId === id))
				.filter((item): item is NonNullable<typeof item> => item !== undefined && item.severity === "required");
			if (result.verdict === "verified") {
				expect(result.blockingClaimIds).toEqual([]);
				expect(unresolved).toEqual([]);
				expect(completeness).toBe("complete");
				expect(roots.every((root) => root.verdict === "satisfied" || root.verdict === "waived")).toBe(true);
			}
			expect(result.verdict === "violated", `run ${run}`).toBe(roots.some((root) => root.verdict === "violated"));
			expect(result.verdict === "unverified").toBe(roots.length === 0);
			for (const id of result.minimalBlockingCut) expect(result.blockingClaimIds).toContain(id);
			for (const id of result.blockingClaimIds) {
				const evaluation = result.claimEvaluations.find((item) => item.claimId === id);
				expect(evaluation?.severity).toBe("required");
			}
			// Adding supporting witnesses is monotone: a verified closure stays verified.
			const supportive = evaluateProofClosure({
				...base,
				observations: [
					...observations,
					...graphValue.claims.map((node) => supports(`extra-${node.claimId}`, [node.claimId])),
				],
			});
			if (result.verdict === "verified") expect(supportive.verdict).toBe("verified");
		}
	});
});
