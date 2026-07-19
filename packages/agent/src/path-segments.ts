/**
 * Path segment helpers without node:path — safe for browser bundles (browser-smoke).
 */

export function normalizePathSlashes(raw: string): string {
	return raw.replace(/\\/g, "/");
}

export function pathSegments(normalized: string): string[] {
	return normalized.split("/").filter((s) => s.length > 0);
}

/** Join cwd and relative path using forward slashes only. */
export function joinPathSegments(cwd: string, relative: string): string {
	const base = normalizePathSlashes(cwd).replace(/\/+$/, "");
	const rel = normalizePathSlashes(relative);
	if (rel.length === 0) {
		return base || "/";
	}
	if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
		return rel;
	}
	return `${base}/${rel}`;
}

/**
 * Collapse "." and ".." segments without touching the filesystem. Returns null
 * when a ".." escapes above the root, so callers can fail closed.
 */
export function collapsePathSegments(segments: readonly string[]): string[] | null {
	const collapsed: string[] = [];
	for (const segment of segments) {
		if (segment === ".") continue;
		if (segment === "..") {
			if (collapsed.length === 0) return null;
			collapsed.pop();
			continue;
		}
		collapsed.push(segment);
	}
	return collapsed;
}

/**
 * Canonicalize a path lexically while preserving a Windows drive root. Drive-
 * relative forms such as `C:foo` and UNC forms are ambiguous without platform
 * state and fail closed. Windows drive-root traversal clamps at the drive root,
 * matching rooted path semantics; POSIX/rootless traversal keeps the existing
 * fail-closed behavior.
 */
export function canonicalizeLexicalPath(raw: string): string | null {
	const normalized = normalizePathSlashes(raw);
	if (normalized.startsWith("//")) {
		return null;
	}
	const driveAbsolute = /^([A-Za-z]:)\/+(.*)$/.exec(normalized);
	if (driveAbsolute) {
		const collapsed: string[] = [];
		for (const segment of pathSegments(driveAbsolute[2])) {
			if (segment === ".") continue;
			if (segment === "..") {
				collapsed.pop();
				continue;
			}
			collapsed.push(segment);
		}
		return `${driveAbsolute[1]}/${collapsed.join("/")}`;
	}
	if (/^[A-Za-z]:/.test(normalized)) {
		return null;
	}

	const rooted = normalized.startsWith("/");
	const collapsed = collapsePathSegments(pathSegments(normalized));
	if (collapsed === null) {
		return null;
	}
	return rooted ? `/${collapsed.join("/")}` : collapsed.join("/");
}

interface CanonicalPathParts {
	drive: string | null;
	rooted: boolean;
	segments: string[];
}

function canonicalPathParts(raw: string): CanonicalPathParts | null {
	const canonical = canonicalizeLexicalPath(raw);
	if (canonical === null) {
		return null;
	}
	const driveAbsolute = /^([A-Za-z]:)\/(.*)$/.exec(canonical);
	if (driveAbsolute) {
		return { drive: driveAbsolute[1].toLowerCase(), rooted: true, segments: pathSegments(driveAbsolute[2]) };
	}
	return { drive: null, rooted: canonical.startsWith("/"), segments: pathSegments(canonical) };
}

/**
 * True when two normalized paths may refer to the same file or subtree.
 * Fail-closed: "."/".." are collapsed first, root-escaping paths always count
 * as overlapping, and segments compare case-insensitively so case-aliasing
 * filesystems never split one file into two "independent" paths. Symlinks and
 * hardlinks are not resolved here (no fs access); overlap only forces
 * sequential execution, so false positives are safe.
 */
export function pathSegmentsOverlap(left: string, right: string): boolean {
	const leftPath = canonicalPathParts(left);
	const rightPath = canonicalPathParts(right);
	if (leftPath === null || rightPath === null) {
		return true;
	}
	if (leftPath.drive !== null && rightPath.drive !== null && leftPath.drive !== rightPath.drive) {
		return false;
	}
	if ((leftPath.drive !== null && !rightPath.rooted) || (rightPath.drive !== null && !leftPath.rooted)) {
		return true;
	}
	if (leftPath.segments.length === 0 || rightPath.segments.length === 0) {
		return true;
	}
	const commonLen = Math.min(leftPath.segments.length, rightPath.segments.length);
	for (let i = 0; i < commonLen; i++) {
		if (leftPath.segments[i].toLowerCase() !== rightPath.segments[i].toLowerCase()) {
			return false;
		}
	}
	return true;
}
