import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ResolvedSandboxPath } from "./policy.ts";

export function nearestExistingParent(requestPath: string): string | undefined {
	let current = requestPath;
	while (current !== "/" && current !== "" && current !== ".") {
		if (existsSync(current)) {
			return realpathSync(current);
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export function resolveSandboxPath(root: string, requestPath: string): ResolvedSandboxPath {
	if (requestPath.includes("\0")) {
		return {
			requestedPath: requestPath,
			exists: false,
			error: "Path contains a NUL byte.",
		};
	}

	const absolutePath = isAbsolute(requestPath) ? requestPath : resolve(root, requestPath);

	try {
		const real = realpathSync(absolutePath);
		return {
			requestedPath: requestPath,
			exists: true,
			realPath: real,
			nearestExistingParentRealPath: real,
			isSymlink: real !== resolve(absolutePath),
		};
	} catch {
		const parent = nearestExistingParent(absolutePath);
		return {
			requestedPath: requestPath,
			exists: false,
			nearestExistingParentRealPath: parent,
		};
	}
}
