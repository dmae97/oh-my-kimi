/**
 * Detect cache-mutating `gh` subcommands inside a bash invocation and drop
 * the matching `github-cache` rows so a subsequent `issue://<n>` or
 * `pr://<n>` read sees the post-mutation state instead of the stale
 * pre-mutation snapshot.
 *
 * Triggered before the bash command runs: on success the cache is now
 * empty and the next read fetches fresh; on failure the worst case is one
 * extra `gh` round-trip on the following read. That cost is bounded and
 * eliminates the much-worse "issue shows OPEN for up to softTtlSec after
 * `gh issue close`" failure mode reported by users.
 *
 * Detector scope: ops that change visible issue/PR state — `close`,
 * `reopen`, `merge`, `delete`, `ready`, `lock`, `unlock`, `pin`, `unpin`,
 * `transfer`, plus the comment/review/edit ops that change the rendered
 * body. We deliberately over-invalidate (e.g. all matching rows for the
 * number, all auth_keys) because the upside of staleness elimination
 * dwarfs the cost of one cache miss.
 */
import { invalidateAllForNumber } from "./github-cache";

const PR_URL_PATTERN = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i;

/** Subcommands that mutate the rendered issue/PR view in any meaningful way. */
const MUTATING_ISSUE_SUBCMDS: Record<string, true> = {
	close: true,
	reopen: true,
	delete: true,
	edit: true,
	comment: true,
	lock: true,
	unlock: true,
	pin: true,
	unpin: true,
	transfer: true,
	develop: true,
};

const MUTATING_PR_SUBCMDS: Record<string, true> = {
	close: true,
	reopen: true,
	merge: true,
	ready: true,
	edit: true,
	comment: true,
	review: true,
	lock: true,
	unlock: true,
};
/**
 * Walk a single shell command's token stream looking for a top-level
 * `gh (issue|pr) <subcmd> <id-or-url>` invocation and return the
 * invalidation key when one is found. Returns `null` for non-matching
 * commands so the caller can iterate cheaply.
 */
function detectGhMutation(tokens: readonly string[]): { number: number; repo?: string } | null {
	const ghIdx = tokens.indexOf("gh");
	if (ghIdx === -1) return null;
	const subject = tokens[ghIdx + 1];
	if (subject !== "issue" && subject !== "pr") return null;
	const subcmd = tokens[ghIdx + 2];
	if (!subcmd) return null;
	const expected = subject === "issue" ? MUTATING_ISSUE_SUBCMDS : MUTATING_PR_SUBCMDS;
	if (!expected[subcmd]) return null;

	let repo: string | undefined;
	// First pass: scan for --repo so it wins regardless of position relative
	// to the issue/PR identifier (gh accepts the flag both before and after
	// the positional argument).
	for (let i = ghIdx + 3; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-R" || token === "--repo") {
			const next = tokens[i + 1];
			if (next) repo = next;
			i++;
			continue;
		}
		if (token.startsWith("--repo=")) {
			repo = token.slice("--repo=".length);
		}
	}
	for (let i = ghIdx + 3; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-R" || token === "--repo") {
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		const direct = /^\d+$/.test(token) ? Number(token) : undefined;
		if (direct !== undefined && Number.isSafeInteger(direct) && direct > 0) {
			return repo !== undefined ? { number: direct, repo } : { number: direct };
		}
		const urlMatch = (subject === "pr" ? PR_URL_PATTERN : ISSUE_URL_PATTERN).exec(token);
		if (urlMatch) {
			const num = Number(urlMatch[2]);
			if (Number.isSafeInteger(num) && num > 0) {
				// URL carries its own repo and wins over a stray --repo flag.
				return { number: num, repo: urlMatch[1] };
			}
		}
	}
	return null;
}

/**
 * Conservative tokenizer that splits a bash command into individual word
 * tokens. Handles single/double-quoted strings, backslash escapes, and
 * standard operators (`;`, `&&`, `||`, `|`, `&`, newlines) as token
 * boundaries that emit a sentinel `";"` so the caller treats the segments
 * as independent command sequences. We do not attempt full POSIX shell
 * parsing — heredocs, command substitution, and arithmetic expansion are
 * out of scope; the detector simply falls through when it cannot find a
 * clean `gh issue|pr <subcmd>` triple.
 */
function tokenize(command: string): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	let buffer = "";
	let inSingle = false;
	let inDouble = false;
	const pushBuffer = () => {
		if (buffer.length > 0) {
			current.push(buffer);
			buffer = "";
		}
	};
	const pushSegment = () => {
		pushBuffer();
		if (current.length > 0) segments.push(current);
		current = [];
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			buffer += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					buffer += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			buffer += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			buffer += command[i + 1];
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushBuffer();
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
			pushSegment();
			// `&&`, `||` already collapsed by the segment break above.
			continue;
		}
		buffer += ch;
	}
	pushSegment();
	return segments;
}

/**
 * Drop `github-cache` rows for any `gh issue|pr <mutating-subcmd>` call
 * embedded in `command`. Safe to invoke unconditionally; no-op when the
 * command does not touch GitHub state.
 */
export function invalidateGithubCacheForBashCommand(command: string): void {
	if (!command?.includes("gh")) return;
	const segments = tokenize(command);
	for (const segment of segments) {
		const hit = detectGhMutation(segment);
		if (!hit) continue;
		invalidateAllForNumber(hit.number, hit.repo);
	}
}
