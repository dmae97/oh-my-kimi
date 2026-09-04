/**
 * Proof closure evaluation over a claim graph (plan §5.5).
 *
 * Order of operations, each step pure and deterministic:
 *
 * 1. Drop observations bound to another source root or environment.
 * 2. Classify expired observations and observations missing one of a claim's
 *    invalidation keys as stale for that claim.
 * 3. A qualified counterexample decides `violated` before any witness counts.
 * 4. Leaf witnesses below the claim's trust floor never count; distinct
 *    independence groups must reach `requiredWitnesses`.
 * 5. Composite claims fold their *required* children (`all` = worst child,
 *    `any` = best child) in topological order, so a parent is never read
 *    before its inputs. Advisory children are reported but never fold into a
 *    parent, and a composite with no required children is witnessed like a leaf.
 * 6. A scope-sensitive claim is blocked while the workspace witness is not
 *    complete; an unresolved effect blocks the whole closure.
 * 7. A waiver removes an unclosed claim from the required set. It never
 *    removes a violated one: a counterexample beats a waiver.
 *
 * The public verdict is decided by the required *roots* (claims nobody lists
 * as an input): `verified` only when every required root is closed, no effect
 * is unresolved, and the workspace witness is complete. A required leaf under
 * an `any` parent therefore blocks nothing once a sibling branch closes — that
 * is what `any` means — while `blockingClaimIds` still lists every required
 * claim on a blocking path so the cause is explainable.
 */

import { isBlockingVerdict, minimalBlockingCut } from "./claim-blocking-cut.ts";
import { ClaimGraphError, rootClaimIds, topologicalClaimOrder, validateClaimGraph } from "./claim-graph.ts";
import {
	CLAIM_VERDICT_PRECEDENCE,
	type ClaimClosureEvaluation,
	type ClaimNode,
	type ClaimReasonCode,
	type ClaimVerdict,
	OBSERVATION_TRUST_RANK,
	type ObservationNode,
	type ProofClosureInput,
	type ProofClosureResult,
	type VerificationVerdict,
	type WaiverNode,
} from "./claim-types.ts";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Witnesses {
	readonly supporting: ObservationNode[];
	readonly violating: ObservationNode[];
	readonly stale: ObservationNode[];
}

function compareCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function requireTimestamp(value: string, label: string): string {
	if (!ISO_TIMESTAMP.test(value))
		throw new ClaimGraphError("invalid_input", `${label} must be an ISO-8601 UTC instant`);
	return value;
}

function reasonFor(verdict: ClaimVerdict): ClaimReasonCode {
	return `claim.${verdict}` as ClaimReasonCode;
}

function worst(verdicts: readonly ClaimVerdict[]): ClaimVerdict {
	return [...verdicts].sort((a, b) => CLAIM_VERDICT_PRECEDENCE.indexOf(a) - CLAIM_VERDICT_PRECEDENCE.indexOf(b))[0];
}

function best(verdicts: readonly ClaimVerdict[]): ClaimVerdict {
	return [...verdicts].sort((a, b) => CLAIM_VERDICT_PRECEDENCE.indexOf(b) - CLAIM_VERDICT_PRECEDENCE.indexOf(a))[0];
}

/** Steps 1–2: bind observations to claims, dropping foreign ones and marking stale ones. */
function indexWitnesses(input: ProofClosureInput, claims: ReadonlyMap<string, ClaimNode>): Map<string, Witnesses> {
	const index = new Map<string, Witnesses>();
	for (const claim of claims.values()) index.set(claim.claimId, { supporting: [], violating: [], stale: [] });
	for (const observation of input.observations) {
		if (observation.sourceRoot !== input.sourceRoot || observation.environmentDigest !== input.environmentDigest)
			continue;
		const expired =
			observation.validUntil !== undefined && requireTimestamp(observation.validUntil, "validUntil") <= input.now;
		const attested = observation.invalidationKeys ?? [];
		for (const claimId of observation.claimIds) {
			const claim = claims.get(claimId);
			const witnesses = index.get(claimId);
			if (claim === undefined || witnesses === undefined) continue;
			const missingKey = claim.invalidationKeys.some((key) => !attested.includes(key));
			if (expired || missingKey) witnesses.stale.push(observation);
			else if (observation.polarity === "violates") witnesses.violating.push(observation);
			else witnesses.supporting.push(observation);
		}
	}
	return index;
}

function ids(observations: readonly ObservationNode[]): readonly string[] {
	return observations.map((observation) => observation.observationId).sort(compareCodeUnits);
}

/** Steps 3–4 for a leaf claim. */
function evaluateLeaf(
	claim: ClaimNode,
	witnesses: Witnesses,
): { verdict: ClaimVerdict; observationIds: readonly string[] } {
	if (witnesses.violating.length > 0) return { verdict: "violated", observationIds: ids(witnesses.violating) };
	const floor = OBSERVATION_TRUST_RANK[claim.trustFloor];
	const trusted = witnesses.supporting.filter((observation) => OBSERVATION_TRUST_RANK[observation.source] >= floor);
	const groups = new Set(trusted.map((observation) => observation.independenceGroup ?? observation.observationId));
	if (groups.size >= (claim.requiredWitnesses ?? 1)) return { verdict: "satisfied", observationIds: ids(trusted) };
	if (trusted.length > 0) return { verdict: "missing", observationIds: ids(trusted) };
	if (witnesses.supporting.length > 0)
		return { verdict: "insufficient_trust", observationIds: ids(witnesses.supporting) };
	if (witnesses.stale.length > 0) return { verdict: "stale", observationIds: ids(witnesses.stale) };
	return { verdict: "missing", observationIds: [] };
}

/** Inputs that take part in a parent's fold: advisory children are informational only. */
function requiredInputs(claim: ClaimNode, claims: ReadonlyMap<string, ClaimNode>): readonly string[] {
	return claim.satisfaction.inputs.filter((input) => claims.get(input)?.severity === "required");
}

function isClosed(verdict: ClaimVerdict): boolean {
	return verdict === "satisfied" || verdict === "waived";
}

/** Step 5 for a composite claim; its required children are already evaluated. */
function evaluateComposite(
	claim: ClaimNode,
	inputs: readonly string[],
	witnesses: Witnesses,
	evaluations: ReadonlyMap<string, ClaimClosureEvaluation>,
): { verdict: ClaimVerdict; observationIds: readonly string[] } {
	if (witnesses.violating.length > 0) return { verdict: "violated", observationIds: ids(witnesses.violating) };
	const childVerdicts = inputs.map((input) => evaluations.get(input)?.verdict ?? "missing");
	if (claim.satisfaction.rule === "all") {
		const open = childVerdicts.filter((verdict) => !isClosed(verdict));
		return { verdict: open.length === 0 ? "satisfied" : worst(open), observationIds: [] };
	}
	if (childVerdicts.some(isClosed)) return { verdict: "satisfied", observationIds: [] };
	return { verdict: best(childVerdicts), observationIds: [] };
}

/** Step 7: the lexically first valid waiver for a claim, or none. */
function indexWaivers(input: ProofClosureInput, claims: ReadonlyMap<string, ClaimNode>): Map<string, WaiverNode> {
	const byClaim = new Map<string, WaiverNode>();
	for (const waiver of [...input.waivers].sort((a, b) => compareCodeUnits(a.waiverId, b.waiverId))) {
		if (!claims.has(waiver.claimId))
			throw new ClaimGraphError("unknown_input", `${waiver.waiverId} waives unknown ${waiver.claimId}`);
		if (waiver.sourceRoot !== input.sourceRoot) continue;
		if (requireTimestamp(waiver.expiresAt, "expiresAt") <= input.now) continue;
		if (!byClaim.has(waiver.claimId)) byClaim.set(waiver.claimId, waiver);
	}
	return byClaim;
}

/** Required claims on a blocking path from a blocking required root, in graph order. */
function blockingPathClaimIds(
	claims: ReadonlyMap<string, ClaimNode>,
	evaluations: ReadonlyMap<string, ClaimClosureEvaluation>,
	blockingRoots: readonly string[],
	graphOrder: readonly string[],
): readonly string[] {
	const onPath = new Set<string>();
	const visit = (claimId: string): void => {
		if (onPath.has(claimId)) return;
		const claim = claims.get(claimId);
		const verdict = evaluations.get(claimId)?.verdict;
		if (claim === undefined || verdict === undefined || !isBlockingVerdict(verdict)) return;
		onPath.add(claimId);
		for (const input of requiredInputs(claim, claims)) visit(input);
	};
	for (const root of blockingRoots) visit(root);
	return graphOrder.filter((claimId) => onPath.has(claimId));
}

function globalVerdict(
	requiredRoots: readonly ClaimClosureEvaluation[],
	input: ProofClosureInput,
): VerificationVerdict {
	if (requiredRoots.length === 0) return "unverified";
	if (requiredRoots.some((root) => root.verdict === "violated")) return "violated";
	const closure =
		requiredRoots.every((root) => isClosed(root.verdict)) &&
		input.unresolvedEffectIds.length === 0 &&
		input.workspaceCompleteness === "complete";
	return closure ? "verified" : "inconclusive";
}

export function evaluateProofClosure(input: ProofClosureInput): ProofClosureResult {
	const claims = validateClaimGraph(input.graph);
	requireTimestamp(input.now, "now");
	const witnesses = indexWitnesses(input, claims);
	const waivers = indexWaivers(input, claims);
	const evaluations = new Map<string, ClaimClosureEvaluation>();
	for (const claim of topologicalClaimOrder(input.graph, claims)) {
		const claimWitnesses = witnesses.get(claim.claimId) as Witnesses;
		const inputs = requiredInputs(claim, claims);
		const local =
			inputs.length === 0
				? evaluateLeaf(claim, claimWitnesses)
				: evaluateComposite(claim, inputs, claimWitnesses, evaluations);
		let verdict = local.verdict;
		if (verdict !== "violated" && claim.scopeSensitive === true && input.workspaceCompleteness !== "complete") {
			verdict = "incomplete_scope";
		}
		const waiver = waivers.get(claim.claimId);
		const waived = waiver !== undefined && verdict !== "violated" && verdict !== "satisfied";
		if (waived) verdict = "waived";
		evaluations.set(
			claim.claimId,
			Object.freeze({
				claimId: claim.claimId,
				severity: claim.severity,
				verdict,
				reasonCode: reasonFor(verdict),
				observationIds: Object.freeze([...local.observationIds]),
				...(waived ? { waiverId: waiver.waiverId } : {}),
			}),
		);
	}
	const graphOrder = input.graph.claims.map((claim) => claim.claimId);
	const ordered = graphOrder.map((claimId) => evaluations.get(claimId) as ClaimClosureEvaluation);
	const requiredRoots = rootClaimIds(input.graph)
		.map((claimId) => evaluations.get(claimId) as ClaimClosureEvaluation)
		.filter((evaluation) => evaluation.severity === "required");
	const blockingRoots = requiredRoots
		.filter((evaluation) => isBlockingVerdict(evaluation.verdict))
		.map((evaluation) => evaluation.claimId);
	const blockingClaimIds = blockingPathClaimIds(claims, evaluations, blockingRoots, graphOrder);
	return Object.freeze({
		verdict: globalVerdict(requiredRoots, input),
		claimEvaluations: Object.freeze(ordered),
		blockingClaimIds: Object.freeze(blockingClaimIds),
		minimalBlockingCut: Object.freeze([...minimalBlockingCut(claims, evaluations, blockingRoots)]),
		unresolvedEffectIds: Object.freeze([...input.unresolvedEffectIds].sort(compareCodeUnits)),
		workspaceCompleteness: input.workspaceCompleteness,
	});
}
