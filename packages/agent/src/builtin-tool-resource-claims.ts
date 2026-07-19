import type { ToolParallelPolicy } from "./parallel-tool-batch.ts";
import { NEVER_PARALLEL_TOOLS, PARALLEL_SAFE_TOOLS, PATH_SCOPED_TOOLS } from "./parallel-tool-batch.ts";
import {
	canonicalizeLexicalPath,
	joinPathSegments,
	normalizePathSlashes,
	pathSegmentsOverlap,
} from "./path-segments.ts";
import type {
	ClaimableToolCall,
	RegisteredToolClaimDefinition,
	ResolveToolClaimsOptions,
	ToolClaimResolution,
} from "./tool-resource-claims.ts";
import type { AgentTool, ResolvedResourceKeys, ToolResourceAccess, ToolResourceClaim } from "./types.ts";

const SEARCH_PATH_TOOLS = new Set<string>(["grep", "find", "ls", "search_files"]);

export function isPlainArguments(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function findRegisteredToolClaimDefinition(
	name: string,
	registeredTools: readonly RegisteredToolClaimDefinition[] | undefined,
): RegisteredToolClaimDefinition | undefined {
	return registeredTools?.find((tool) => tool.name === name);
}

/** Bind a fixed call identity without spreading away prototype tool methods. */
export function bindToolIdentity(candidate: AgentTool, name: string): AgentTool {
	const tool: AgentTool = Object.create(candidate);
	Object.defineProperty(tool, "name", { enumerable: true, value: name });
	Object.defineProperty(tool, "execute", { value: candidate.execute.bind(candidate) });
	if (candidate.prepareArguments) {
		Object.defineProperty(tool, "prepareArguments", { value: candidate.prepareArguments.bind(candidate) });
	}
	if (candidate.resourceClaims) {
		Object.defineProperty(tool, "resourceClaims", { value: candidate.resourceClaims.bind(candidate) });
	}
	return Object.freeze(tool);
}

export function resolveToolPolicy(name: string, options: ResolveToolClaimsOptions): ToolParallelPolicy | undefined {
	return (
		findRegisteredToolClaimDefinition(name, options.registeredTools)?.executionMode ?? options.toolPolicies?.get(name)
	);
}

export function isBuiltinPathClaimTool(name: string): boolean {
	return PATH_SCOPED_TOOLS.has(name) || SEARCH_PATH_TOOLS.has(name);
}

function normalizeLeadingSlashes(rawPath: string): string {
	const normalized = normalizePathSlashes(rawPath);
	return /^\/{3,}/.test(normalized) ? normalized.replace(/^\/+/, "/") : normalized;
}

function resolveCanonicalPathKey(rawPath: unknown, cwd: unknown): string | null {
	if (typeof rawPath !== "string" || rawPath.trim().length === 0 || typeof cwd !== "string") return null;
	const normalized = normalizeLeadingSlashes(rawPath);
	const canonicalCwd = canonicalizeLexicalPath(cwd);
	if (
		normalized.startsWith("//") ||
		/^[A-Za-z]:(?!\/)/.test(normalized) ||
		canonicalCwd === null ||
		!(canonicalCwd.startsWith("/") || /^[A-Za-z]:\//.test(canonicalCwd))
	) {
		return null;
	}

	let resolved: string;
	if (/^[A-Za-z]:\//.test(normalized)) {
		resolved = normalized;
	} else if (normalized.startsWith("/")) {
		const cwdDrive = /^([A-Za-z]:)\//.exec(canonicalCwd);
		resolved = cwdDrive ? `${cwdDrive[1]}${normalized}` : normalized;
	} else {
		resolved = joinPathSegments(canonicalCwd, normalized);
	}
	const canonical = canonicalizeLexicalPath(resolved);
	return canonical !== null && (canonical.startsWith("/") || /^[A-Za-z]:\//.test(canonical)) ? canonical : null;
}

function builtinRawPath(toolName: string, args: Record<string, unknown>, cwd: string): unknown {
	if (PATH_SCOPED_TOOLS.has(toolName)) return args.path;
	if (!SEARCH_PATH_TOOLS.has(toolName)) return undefined;
	return typeof args.path === "string" && args.path.trim().length > 0 ? args.path : cwd;
}

function builtinPathAccess(toolName: string): ToolResourceAccess {
	return toolName === "read" || SEARCH_PATH_TOOLS.has(toolName) ? "read" : "write";
}

export function resolvePathClaimKey(toolName: string, args: Record<string, unknown>, cwd: string): string | null {
	return isBuiltinPathClaimTool(toolName) ? resolveCanonicalPathKey(builtinRawPath(toolName, args, cwd), cwd) : null;
}

function canonicalizeResolvedPathKey(rawPath: unknown): string | null {
	if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
	const normalized = normalizeLeadingSlashes(rawPath);
	if (normalized.startsWith("//")) {
		const match = /^\/\/+([^/]+)\/+([^/]+)(?:\/+(.*))?$/.exec(normalized);
		if (!match) return null;
		const suffix = match[3] ?? "";
		const canonicalSuffix = suffix.length === 0 ? "" : canonicalizeLexicalPath(suffix);
		if (canonicalSuffix === null) return null;
		const root = `//${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
		return canonicalSuffix.length === 0 ? root : `${root}/${canonicalSuffix}`;
	}
	const canonical = canonicalizeLexicalPath(normalized);
	if (canonical === null) return null;
	const drive = /^([A-Za-z]:)\/(.*)$/.exec(canonical);
	if (drive) return `${drive[1].toLowerCase()}/${drive[2]}`;
	return canonical.startsWith("/") ? canonical : null;
}

function normalizeResolvedResourceKeys(value: unknown): ResolvedResourceKeys | null {
	if (!isPlainArguments(value)) return null;
	const lexicalKey = canonicalizeResolvedPathKey(value.lexicalKey);
	if (lexicalKey === null) return null;
	const realKey = value.realKey === undefined ? undefined : canonicalizeResolvedPathKey(value.realKey);
	if (realKey === null || (value.inodeKey !== undefined && (typeof value.inodeKey !== "string" || !value.inodeKey))) {
		return null;
	}
	const inodeKey = value.inodeKey;
	if (
		(lexicalKey.startsWith("//") || /^[a-z]:\//.test(lexicalKey)) &&
		realKey === undefined &&
		inodeKey === undefined
	) {
		return null;
	}
	return {
		lexicalKey,
		...(realKey === undefined ? {} : { realKey }),
		...(inodeKey === undefined ? {} : { inodeKey }),
	};
}

export async function resolvePathClaimWithIdentity(
	rawPath: unknown,
	access: ToolResourceAccess,
	options: ResolveToolClaimsOptions,
): Promise<ToolClaimResolution> {
	if (typeof rawPath !== "string" || rawPath.trim().length === 0) return { kind: "exclusive" };
	const resolver = options.resourceKeyResolver;
	if (!resolver) {
		const key = resolveCanonicalPathKey(rawPath, options.cwd);
		return key === null ? { kind: "exclusive" } : { kind: "claims", claims: [{ kind: "path", key, access }] };
	}
	try {
		const keys = normalizeResolvedResourceKeys(await resolver.resolvePath(rawPath, options.cwd));
		if (keys === null) return { kind: "exclusive" };
		return {
			kind: "claims",
			claims: [
				{
					kind: "path",
					key: keys.lexicalKey,
					access,
					...(keys.realKey === undefined ? {} : { realKey: keys.realKey }),
					...(keys.inodeKey === undefined ? {} : { inodeKey: keys.inodeKey }),
				},
			],
		};
	} catch {
		return { kind: "exclusive" };
	}
}

export function resolveBuiltinPathClaimWithIdentity(
	toolCall: ClaimableToolCall,
	options: ResolveToolClaimsOptions,
): Promise<ToolClaimResolution> {
	if (!isPlainArguments(toolCall.arguments)) return Promise.resolve({ kind: "exclusive" });
	return resolvePathClaimWithIdentity(
		builtinRawPath(toolCall.name, toolCall.arguments, options.cwd),
		builtinPathAccess(toolCall.name),
		options,
	);
}

export function resolveToolClaims(toolCall: ClaimableToolCall, options: ResolveToolClaimsOptions): ToolClaimResolution {
	if (!isPlainArguments(toolCall.arguments)) return { kind: "exclusive" };
	const name = toolCall.name;
	if (NEVER_PARALLEL_TOOLS.has(name) || name === "bash" || resolveToolPolicy(name, options) === "sequential") {
		return { kind: "exclusive" };
	}
	if (isBuiltinPathClaimTool(name)) {
		const key = resolvePathClaimKey(name, toolCall.arguments, options.cwd);
		return key === null
			? { kind: "exclusive" }
			: { kind: "claims", claims: [{ access: builtinPathAccess(name), kind: "path", key }] };
	}
	if (PARALLEL_SAFE_TOOLS.has(name)) return { kind: "claims", claims: [] };
	if (resolveToolPolicy(name, options) === "parallel") {
		return options.strictExtensionClaims ? { kind: "exclusive" } : { kind: "claims", claims: [] };
	}
	return { kind: "exclusive" };
}

function pathClaimKeys(claim: Extract<ToolResourceClaim, { kind: "path" }>): string[] {
	return claim.realKey === undefined || claim.realKey === claim.key ? [claim.key] : [claim.key, claim.realKey];
}

function uncSegments(key: string): string[] | null {
	return key.startsWith("//")
		? key
				.slice(2)
				.split("/")
				.filter((segment) => segment.length > 0)
				.map((segment) => segment.toLowerCase())
		: null;
}

function identityPathKeysOverlap(left: string, right: string): boolean {
	const leftUnc = uncSegments(left);
	const rightUnc = uncSegments(right);
	if (leftUnc === null || rightUnc === null) {
		return leftUnc === null && rightUnc === null && pathSegmentsOverlap(left, right);
	}
	const commonLength = Math.min(leftUnc.length, rightUnc.length);
	for (let index = 0; index < commonLength; index++) {
		if (leftUnc[index] !== rightUnc[index]) return false;
	}
	return true;
}

export function pathClaimsOverlap(
	left: Extract<ToolResourceClaim, { kind: "path" }>,
	right: Extract<ToolResourceClaim, { kind: "path" }>,
): boolean {
	if (left.inodeKey !== undefined && left.inodeKey === right.inodeKey) return true;
	return pathClaimKeys(left).some((leftKey) =>
		pathClaimKeys(right).some((rightKey) => identityPathKeysOverlap(leftKey, rightKey)),
	);
}
