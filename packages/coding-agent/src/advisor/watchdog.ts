import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { expandAtImports } from "../discovery/at-imports";
import { repo } from "../utils/git";

/**
 * Discover and load WATCHDOG.md files walking up from cwd, project .omp folder, and user agent dir.
 * Returns formatted watchdog file blocks ready to be appended to the advisor system prompt.
 */
export async function discoverWatchdogFiles(cwd: string, agentDir?: string): Promise<string[]> {
	const home = os.homedir();
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const userPath = resolvedAgentDir ? path.resolve(resolvedAgentDir, "WATCHDOG.md") : null;
	let repoRoot: string | null = null;
	try {
		repoRoot = await repo.root(cwd);
	} catch (err) {
		logger.debug("Failed to resolve git root for watchdog discovery", { err: String(err) });
	}

	const candidates = new Set<string>();

	// 1. User level: ~/.omp/WATCHDOG.md (or active profile agent dir)
	if (resolvedAgentDir) {
		candidates.add(path.resolve(resolvedAgentDir, "WATCHDOG.md"));
	}

	// 2. Project levels (both standalone and native config .omp/): walk up from cwd to repoRoot / home
	let current = cwd;
	while (true) {
		candidates.add(path.resolve(current, ".omp", "WATCHDOG.md"));
		candidates.add(path.resolve(current, "WATCHDOG.md"));

		if (current === (repoRoot ?? home)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const items: Array<{ path: string; content: string; level: "user" | "project"; depth: number }> = [];

	for (const candidate of candidates) {
		try {
			const content = await Bun.file(candidate).text();
			const expanded = await expandAtImports(content, candidate);
			const parent = path.dirname(candidate);
			const baseName = parent.split(path.sep).pop() ?? "";

			const isUser = userPath !== null && candidate === userPath;
			const ownerDir = baseName === ".omp" ? path.dirname(parent) : parent;
			const ownerBaseName = ownerDir.split(path.sep).pop() ?? "";

			if (isUser || !ownerBaseName.startsWith(".") || baseName === ".omp") {
				const relative = path.relative(cwd, ownerDir);
				const depth = relative === "" ? 0 : relative.split(path.sep).filter(Boolean).length;
				items.push({
					path: candidate,
					content: expanded,
					level: isUser ? "user" : "project",
					depth,
				});
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to read WATCHDOG.md candidate", { path: candidate, error: String(err) });
			}
		}
	}

	// Sort files so that user level comes first, then project level sorted by depth (descending).
	// This means user-level rules are first, then project-level rules from ancestor directories down to the leaf directory (depth 0 is last/most prominent).
	items.sort((a, b) => {
		if (a.level !== b.level) {
			return a.level === "user" ? -1 : 1;
		}
		return b.depth - a.depth;
	});

	return items.map(item => {
		return `Especially pay attention to:\n<attention>\n${item.content}\n</attention>`;
	});
}
