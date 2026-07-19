/**
 * Node-only resource-key identity resolver for the dag-v2 scheduler (§5.5
 * stage 2). The browser-safe lexical layer in `path-segments.ts` cannot see
 * symlinks, hardlinks, or platform path aliasing; this resolver adds that
 * identity without ever weakening the lexical layer:
 *
 * 1. tilde expansion (Node adapter only), then lexical canonicalization
 * 2. POSIX three-or-more leading slashes collapse to one rooted identity
 * 3. unresolved Windows drive/UNC paths return `null` (exclusive scheduling)
 * 4. nearest existing ancestor `realpath`, including dangling-symlink targets
 * 5. `dev:ino` identity when the full path exists
 * 6. filesystem failure falls back to the lexical POSIX key
 *
 * This module is exported from `omk-agent-core/node` only; the main package
 * entry stays platform-free.
 */

import {
	lstat as lstatAsync,
	readlink as readlinkAsync,
	realpath as realpathAsync,
	stat as statAsync,
} from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { canonicalizeLexicalPath, joinPathSegments, normalizePathSlashes } from "./path-segments.ts";
import type { ResolvedResourceKeys, ResourceKeyResolver } from "./types.ts";

const MAX_DANGLING_SYMLINK_DEPTH = 40;

export interface NodeResourceKeyResolverOptions {
	/** Home directory used for tilde expansion. Default: `os.homedir`. */
	homedir?: () => string;
	/** Injectable realpath (tests / hardened environments). Default: `fs.promises.realpath`. */
	realpath?: (path: string) => Promise<string>;
	/** Injectable stat. Default: `fs.promises.stat`. */
	stat?: (path: string) => Promise<{ dev: number | bigint; ino: number | bigint }>;
	/** Injectable lstat used to identify dangling symlinks. */
	lstat?: (path: string) => Promise<{ isSymbolicLink(): boolean }>;
	/** Injectable readlink used to resolve dangling symlink targets. */
	readlink?: (path: string) => Promise<string>;
}

/** Split a canonical rooted POSIX-style path into ancestor candidates, deepest first. */
function ancestorPaths(canonical: string): string[] {
	const ancestors: string[] = [];
	let current = canonical;
	while (current.length > 1) {
		const slash = current.lastIndexOf("/");
		if (slash <= 0) {
			ancestors.push("/");
			return ancestors;
		}
		current = current.slice(0, slash);
		ancestors.push(current);
	}
	return ancestors;
}

/**
 * Create the Node identity resolver. Pure lexical work is synchronous and
 * deterministic; filesystem identity is best-effort and every failure falls
 * back to the lexical key so scheduling never gets *less* safe than the
 * browser-safe layer.
 */
export function createNodeResourceKeyResolver(options: NodeResourceKeyResolverOptions = {}): ResourceKeyResolver {
	const home = options.homedir ?? osHomedir;
	const realpath = options.realpath ?? ((path: string) => realpathAsync(path));
	const stat = options.stat ?? ((path: string) => statAsync(path));
	const lstat = options.lstat ?? ((path: string) => lstatAsync(path));
	const readlink = options.readlink ?? ((path: string) => readlinkAsync(path));

	const suffixAfter = (path: string, ancestor: string): string =>
		path.slice(ancestor.length === 1 ? 1 : ancestor.length + 1);

	async function nearestRealKey(canonical: string): Promise<string | undefined> {
		for (const ancestor of [canonical, ...ancestorPaths(canonical)]) {
			if (!(await stat(ancestor).catch(() => null))) continue;
			const realAncestor = canonicalizeLexicalPath(normalizePathSlashes(await realpath(ancestor)));
			if (realAncestor === null) return undefined;
			const suffix = suffixAfter(canonical, ancestor);
			return suffix.length === 0 ? realAncestor : joinPathSegments(realAncestor, suffix);
		}
		return undefined;
	}

	async function danglingSymlinkTarget(canonical: string): Promise<string | null | undefined> {
		for (const candidate of [canonical, ...ancestorPaths(canonical)]) {
			const metadata = await lstat(candidate).catch(() => null);
			if (!metadata?.isSymbolicLink()) continue;
			let target = normalizePathSlashes(await readlink(candidate));
			if (target.startsWith("/")) target = target.replace(/^\/+/, "/");
			const slash = candidate.lastIndexOf("/");
			const parent = slash <= 0 ? "/" : candidate.slice(0, slash);
			const canonicalTarget = canonicalizeLexicalPath(
				target.startsWith("/") ? target : joinPathSegments(parent, target),
			);
			if (canonicalTarget === null) return null;
			const suffix = suffixAfter(canonical, candidate);
			return suffix.length === 0 ? canonicalTarget : joinPathSegments(canonicalTarget, suffix);
		}
		return undefined;
	}

	async function danglingSymlinkRealKey(canonical: string): Promise<string | undefined> {
		const seen = new Set<string>();
		let current = canonical;
		for (let depth = 0; depth < MAX_DANGLING_SYMLINK_DEPTH; depth++) {
			if (seen.has(current)) return undefined;
			seen.add(current);
			const target = await danglingSymlinkTarget(current);
			if (target === null) return undefined;
			if (target === undefined) return nearestRealKey(current);
			current = target;
		}
		return undefined;
	}

	async function resolveIdentity(canonical: string): Promise<Pick<ResolvedResourceKeys, "realKey" | "inodeKey">> {
		const identity: { realKey?: string; inodeKey?: string } = {};
		try {
			const target = await stat(canonical).catch(() => null);
			if (target) {
				identity.inodeKey = `${target.dev}:${target.ino}`;
				identity.realKey = await nearestRealKey(canonical);
				return identity;
			}
			identity.realKey = await danglingSymlinkRealKey(canonical);
			return identity;
		} catch {
			return {};
		}
	}

	return {
		async resolvePath(rawPath: string, cwd: string): Promise<ResolvedResourceKeys | null> {
			if (typeof rawPath !== "string" || rawPath.trim().length === 0 || typeof cwd !== "string") {
				return null;
			}
			let normalized = normalizePathSlashes(rawPath);
			if (/^\/{3,}/.test(normalized)) normalized = normalized.replace(/^\/+/, "/");
			// Tilde expansion happens only in this Node adapter (§5.5 stage 1 note).
			if (normalized === "~" || normalized.startsWith("~/")) {
				try {
					normalized = joinPathSegments(
						normalizePathSlashes(home()),
						normalized === "~" ? "" : normalized.slice(2),
					);
				} catch {
					return null;
				}
			}

			// This POSIX resolver cannot establish filesystem identity for Windows
			// drive or UNC paths. Null makes each call exclusive instead of sharing an
			// unsafe lexical-only claim with another call.
			if (normalized.startsWith("//") || /^[A-Za-z]:(?:\/|$)/.test(normalized)) return null;

			const joined = normalized.startsWith("/") ? normalized : joinPathSegments(cwd, normalized);
			const canonical = canonicalizeLexicalPath(joined);
			if (canonical === null) {
				// Root escapes, drive-relative forms, and other ambiguous shapes fail closed.
				return null;
			}
			if (/^[A-Za-z]:\//.test(canonical)) return null;
			if (!canonical.startsWith("/")) {
				// Still relative after canonicalization (non-anchored cwd): fail closed.
				return null;
			}

			return { lexicalKey: canonical, ...(await resolveIdentity(canonical)) };
		},
	};
}
