import * as path from "node:path";

/**
 * Creates a deduplicating recorder for relative file paths.
 * Preserves insertion order in `list`; subsequent duplicates are ignored.
 */
export function createFileRecorder(): {
	record: (relativePath: string) => void;
	list: string[];
} {
	const seen = new Set<string>();
	const list: string[] = [];
	return {
		record(relativePath: string) {
			if (!seen.has(relativePath)) {
				seen.add(relativePath);
				list.push(relativePath);
			}
		},
		list,
	};
}

/**
 * Strip a leading slash and, when the search scope is a directory, normalize
 * Windows-style separators. For single-file scopes, fall back to the basename
 * so tool output does not leak absolute paths.
 */
export function formatResultPath(filePath: string, isDirectory: boolean): string {
	const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
	if (isDirectory) {
		return cleanPath.replace(/\\/g, "/");
	}
	return path.basename(cleanPath);
}
