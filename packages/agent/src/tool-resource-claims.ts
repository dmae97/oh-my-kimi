/** Browser-safe resource claims for the opt-in dag-v2 scheduler. */

import {
	findRegisteredToolClaimDefinition,
	isBuiltinPathClaimTool,
	isPlainArguments,
	pathClaimsOverlap,
	resolveBuiltinPathClaimWithIdentity,
	resolvePathClaimWithIdentity,
	resolveToolClaims,
	resolveToolPolicy,
} from "./builtin-tool-resource-claims.ts";
import type { ToolParallelPolicy } from "./parallel-tool-batch.ts";
import { NEVER_PARALLEL_TOOLS } from "./parallel-tool-batch.ts";
import type { AgentTool, ResourceAccess, ResourceKeyResolver, ToolResourceClaim } from "./types.ts";

export { resolvePathClaimKey, resolveToolClaims } from "./builtin-tool-resource-claims.ts";
export type {
	ResourceAccess,
	ToolResourceAccess,
	ToolResourceClaim,
	ToolResourceClaims,
	ToolResourceClaimsContext,
} from "./types.ts";

export type ToolClaimResolution = { kind: "exclusive" } | { kind: "claims"; claims: ToolResourceClaim[] };

export interface ClaimableToolCall {
	id?: string;
	name: string;
	arguments: unknown;
}

export type RegisteredToolClaimDefinition = Pick<AgentTool, "name" | "executionMode" | "resourceClaims">;

export interface ResolveToolClaimsOptions {
	cwd: string;
	toolPolicies?: ReadonlyMap<string, ToolParallelPolicy>;
	registeredTools?: readonly RegisteredToolClaimDefinition[];
	strictExtensionClaims?: boolean;
	resourceKeyResolver?: ResourceKeyResolver;
}

function isNonPathKind(value: unknown): value is Exclude<ToolResourceClaim["kind"], "path"> {
	return value === "session" || value === "terminal" || value === "network" || value === "global";
}

async function normalizeCustomClaims(value: unknown, options: ResolveToolClaimsOptions): Promise<ToolClaimResolution> {
	if (value === "exclusive") return { kind: "exclusive" };
	if (!Array.isArray(value) || value.length === 0) return { kind: "exclusive" };

	const claims: ToolResourceClaim[] = [];
	let hasExclusiveAccess = false;
	for (const candidate of value) {
		if (!isPlainArguments(candidate) || typeof candidate.key !== "string" || candidate.key.trim().length === 0) {
			return { kind: "exclusive" };
		}
		if (candidate.kind === "path") {
			if (candidate.access !== "read" && candidate.access !== "write") return { kind: "exclusive" };
			const pathResolution = await resolvePathClaimWithIdentity(candidate.key, candidate.access, options);
			if (pathResolution.kind === "exclusive") return pathResolution;
			claims.push(...pathResolution.claims);
			continue;
		}
		if (!isNonPathKind(candidate.kind)) return { kind: "exclusive" };
		if (candidate.access !== "read" && candidate.access !== "write" && candidate.access !== "exclusive") {
			return { kind: "exclusive" };
		}
		const access: ResourceAccess = candidate.access;
		claims.push({ kind: candidate.kind, key: candidate.key, access });
		if (access === "exclusive") hasExclusiveAccess = true;
	}
	return hasExclusiveAccess ? { kind: "exclusive" } : { kind: "claims", claims };
}

/** Resolve one call, failing malformed or rejected extension claims closed. */
export async function resolveToolClaimsForCall(
	toolCall: ClaimableToolCall,
	options: ResolveToolClaimsOptions,
): Promise<ToolClaimResolution> {
	const registeredTool = findRegisteredToolClaimDefinition(toolCall.name, options.registeredTools);
	if (!registeredTool?.resourceClaims) {
		if (
			options.resourceKeyResolver &&
			isBuiltinPathClaimTool(toolCall.name) &&
			isPlainArguments(toolCall.arguments) &&
			!NEVER_PARALLEL_TOOLS.has(toolCall.name) &&
			resolveToolPolicy(toolCall.name, options) !== "sequential"
		) {
			return resolveBuiltinPathClaimWithIdentity(toolCall, options);
		}
		return resolveToolClaims(toolCall, options);
	}
	if (!isPlainArguments(toolCall.arguments)) return { kind: "exclusive" };

	let resolution: ToolClaimResolution;
	try {
		const claims = await registeredTool.resourceClaims(toolCall.arguments, {
			cwd: options.cwd,
			toolCallId: toolCall.id ?? "",
		});
		resolution = await normalizeCustomClaims(claims, options);
	} catch {
		return { kind: "exclusive" };
	}
	if (
		NEVER_PARALLEL_TOOLS.has(toolCall.name) ||
		toolCall.name === "bash" ||
		resolveToolPolicy(toolCall.name, options) === "sequential"
	) {
		return { kind: "exclusive" };
	}
	return resolution;
}

export function compareClaims(left: ToolResourceClaim, right: ToolResourceClaim): number {
	if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
	if (left.key !== right.key) return left.key < right.key ? -1 : 1;
	if (left.access !== right.access) return left.access < right.access ? -1 : 1;
	const leftReal = left.kind === "path" ? (left.realKey ?? "") : "";
	const rightReal = right.kind === "path" ? (right.realKey ?? "") : "";
	if (leftReal !== rightReal) return leftReal < rightReal ? -1 : 1;
	const leftInode = left.kind === "path" ? (left.inodeKey ?? "") : "";
	const rightInode = right.kind === "path" ? (right.inodeKey ?? "") : "";
	if (leftInode !== rightInode) return leftInode < rightInode ? -1 : 1;
	return 0;
}

export function canonicalizeClaims(claims: readonly ToolResourceClaim[]): ToolResourceClaim[] {
	return claims
		.map(
			(claim): ToolResourceClaim =>
				claim.kind === "path"
					? {
							kind: "path",
							key: claim.key,
							access: claim.access,
							...(claim.realKey === undefined ? {} : { realKey: claim.realKey }),
							...(claim.inodeKey === undefined ? {} : { inodeKey: claim.inodeKey }),
						}
					: { kind: claim.kind, key: claim.key, access: claim.access },
		)
		.sort(compareClaims);
}

export function claimsConflict(left: ToolResourceClaim, right: ToolResourceClaim): boolean {
	if (left.access === "exclusive" || right.access === "exclusive") return true;
	if (left.kind !== right.kind) return false;
	if (left.kind === "path" && right.kind === "path") {
		if (!pathClaimsOverlap(left, right)) return false;
	} else if (left.key !== right.key) {
		return false;
	}
	return !(left.access === "read" && right.access === "read");
}

export function resolutionsConflict(left: ToolClaimResolution, right: ToolClaimResolution): boolean {
	if (left.kind === "exclusive" || right.kind === "exclusive") return true;
	for (const leftClaim of left.claims) {
		for (const rightClaim of right.claims) {
			if (claimsConflict(leftClaim, rightClaim)) return true;
		}
	}
	return false;
}
