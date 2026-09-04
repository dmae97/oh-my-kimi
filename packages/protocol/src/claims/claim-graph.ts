/**
 * Structural rules for a claim graph: identity, references, acyclicity, and
 * a deterministic evaluation order.
 *
 * Validation throws `ClaimGraphError` because a malformed graph is a
 * programming or configuration defect, not an evaluation outcome; a proof
 * must never report `inconclusive` for a graph it could not even read.
 *
 * `canonicalClaimGraph` returns the graph in a normalized shape (claims by
 * id, inputs and keys sorted) so that any layer with a hasher can derive the
 * graph digest the plan binds into operations, receipts, and snapshots.
 * This package deliberately owns the normalization and not the hash.
 */

import { CLAIM_GRAPH_SCHEMA_VERSION, type ClaimGraph, type ClaimNode, OBSERVATION_TRUST_RANK } from "./claim-types.ts";

export class ClaimGraphError extends Error {
	public readonly code:
		| "invalid_schema"
		| "invalid_claim"
		| "duplicate_claim"
		| "unknown_input"
		| "cycle"
		| "invalid_input";

	constructor(code: ClaimGraphError["code"], message: string) {
		super(message);
		this.name = "ClaimGraphError";
		this.code = code;
	}
}

function compareCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateClaim(claim: ClaimNode): void {
	const id = claim.claimId;
	if (!isNonEmptyString(id)) throw new ClaimGraphError("invalid_claim", "claimId must be a non-empty string");
	if (!isNonEmptyString(claim.statement)) throw new ClaimGraphError("invalid_claim", `${id}: statement is empty`);
	if (claim.severity !== "required" && claim.severity !== "advisory") {
		throw new ClaimGraphError("invalid_claim", `${id}: severity must be required or advisory`);
	}
	if (claim.satisfaction.rule !== "all" && claim.satisfaction.rule !== "any") {
		throw new ClaimGraphError("invalid_claim", `${id}: satisfaction rule must be all or any`);
	}
	if (typeof OBSERVATION_TRUST_RANK[claim.trustFloor] !== "number") {
		throw new ClaimGraphError("invalid_claim", `${id}: unknown trustFloor ${String(claim.trustFloor)}`);
	}
	const witnesses = claim.requiredWitnesses ?? 1;
	if (!Number.isInteger(witnesses) || witnesses < 1) {
		throw new ClaimGraphError("invalid_claim", `${id}: requiredWitnesses must be a positive integer`);
	}
	if (new Set(claim.satisfaction.inputs).size !== claim.satisfaction.inputs.length) {
		throw new ClaimGraphError("invalid_claim", `${id}: inputs contain duplicates`);
	}
	if (claim.satisfaction.inputs.includes(id)) throw new ClaimGraphError("cycle", `${id} lists itself as an input`);
}

/** Throws on the first structural defect; returns the claims indexed by id otherwise. */
export function validateClaimGraph(graph: ClaimGraph): ReadonlyMap<string, ClaimNode> {
	if (graph.schemaVersion !== CLAIM_GRAPH_SCHEMA_VERSION) {
		throw new ClaimGraphError("invalid_schema", `Unsupported claim graph schema ${String(graph.schemaVersion)}`);
	}
	const byId = new Map<string, ClaimNode>();
	for (const claim of graph.claims) {
		validateClaim(claim);
		if (byId.has(claim.claimId)) throw new ClaimGraphError("duplicate_claim", `Duplicate claim ${claim.claimId}`);
		byId.set(claim.claimId, claim);
	}
	for (const claim of graph.claims) {
		for (const input of claim.satisfaction.inputs) {
			if (!byId.has(input))
				throw new ClaimGraphError("unknown_input", `${claim.claimId} references unknown ${input}`);
		}
	}
	topologicalClaimOrder(graph, byId);
	return byId;
}

/**
 * Children before parents, ties broken by claim id, so evaluation order is a
 * function of the graph alone. Kahn's algorithm; leftover nodes form a cycle.
 */
export function topologicalClaimOrder(graph: ClaimGraph, index?: ReadonlyMap<string, ClaimNode>): readonly ClaimNode[] {
	const byId = index ?? new Map(graph.claims.map((claim) => [claim.claimId, claim]));
	const remainingInputs = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const claim of graph.claims) {
		remainingInputs.set(claim.claimId, claim.satisfaction.inputs.length);
		for (const input of claim.satisfaction.inputs) {
			const list = dependents.get(input) ?? [];
			list.push(claim.claimId);
			dependents.set(input, list);
		}
	}
	const ready = graph.claims
		.filter((claim) => claim.satisfaction.inputs.length === 0)
		.map((claim) => claim.claimId)
		.sort(compareCodeUnits);
	const ordered: ClaimNode[] = [];
	while (ready.length > 0) {
		const id = ready.shift() as string;
		const claim = byId.get(id);
		if (claim !== undefined) ordered.push(claim);
		for (const dependent of (dependents.get(id) ?? []).sort(compareCodeUnits)) {
			const remaining = (remainingInputs.get(dependent) ?? 0) - 1;
			remainingInputs.set(dependent, remaining);
			if (remaining === 0) insertSorted(ready, dependent);
		}
	}
	if (ordered.length !== graph.claims.length) {
		const stuck = graph.claims
			.map((claim) => claim.claimId)
			.filter((id) => !ordered.some((claim) => claim.claimId === id));
		throw new ClaimGraphError(
			"cycle",
			`Claim graph contains a cycle through ${stuck.sort(compareCodeUnits).join(", ")}`,
		);
	}
	return ordered;
}

function insertSorted(list: string[], value: string): void {
	let index = 0;
	while (index < list.length && compareCodeUnits(list[index], value) < 0) index++;
	list.splice(index, 0, value);
}

/** Claims that are nobody's input: the roots a public verdict is reported against. */
export function rootClaimIds(graph: ClaimGraph): readonly string[] {
	const referenced = new Set(graph.claims.flatMap((claim) => claim.satisfaction.inputs));
	return graph.claims
		.map((claim) => claim.claimId)
		.filter((id) => !referenced.has(id))
		.sort(compareCodeUnits);
}

/** Normalized graph for digesting: deterministic member order regardless of input order. */
export function canonicalClaimGraph(graph: ClaimGraph): ClaimGraph {
	const claims = [...graph.claims]
		.sort((left, right) => compareCodeUnits(left.claimId, right.claimId))
		.map((claim) => ({
			claimId: claim.claimId,
			kind: claim.kind,
			statement: claim.statement,
			severity: claim.severity,
			satisfaction: { rule: claim.satisfaction.rule, inputs: [...claim.satisfaction.inputs].sort(compareCodeUnits) },
			trustFloor: claim.trustFloor,
			requiredWitnesses: claim.requiredWitnesses ?? 1,
			scopeSensitive: claim.scopeSensitive ?? false,
			invalidationKeys: [...claim.invalidationKeys].sort(compareCodeUnits),
		}));
	return { schemaVersion: CLAIM_GRAPH_SCHEMA_VERSION, claims };
}
