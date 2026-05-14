/**
 * Conservative transforms applied to a bash command before execution.
 *
 * Currently strips trailing `| head [args]` / `| tail [args]` pipelines that
 * exist purely to limit output length: the harness already truncates bash
 * output and exposes the full result via an artifact, so these pipes only
 * hide content the agent wanted. We refuse to strip in any case where the
 * pipe could carry real semantics (multi-line scripts, follow flags, file
 * arguments, downstream commands, redirects, subshells, etc.).
 */

export interface BashFixupResult {
	/** Possibly-rewritten command. */
	command: string;
	/** Original substring that was removed, if any (verbatim, including the leading `|`). */
	stripped?: string;
}

/**
 * Token shapes for `head`/`tail` that we recognize as pure "limit output" flags.
 *
 * We deliberately reject `-f`, `-F`, `--follow`, `+N` line offsets, filenames,
 * and anything else that could change semantics when removed.
 *
 *   -nN, -n N, -n=N, -cN, -c N, -c=N
 *   -N           (BSD-style `head -5`)
 *   -q, -v, --quiet, --verbose
 *   --lines[=N|  N], --bytes[=N|  N]
 *   bare integer (the value half of `--lines 5` / `-n 5`)
 */
const SAFE_HEAD_TAIL_ARG = String.raw`(?:-[nc]=?\s*\d+|-\d+|-[qv]|--lines(?:=?\s*\d+)?|--bytes(?:=?\s*\d+)?|--quiet|--verbose|\d+)`;

/**
 * Matches a trailing `| head|tail [safe-args]` segment anchored to the end of
 * the command. The leading `\s*` is bounded to inline whitespace (no newline)
 * so a `|` on its own line never gets swallowed.
 */
const TRAILING_HEAD_TAIL_RE = new RegExp(
	String.raw`[ \t]*\|[ \t]*(?:head|tail)(?:[ \t]+${SAFE_HEAD_TAIL_ARG})*[ \t]*$`,
);

/**
 * Strip a trailing `| head` / `| tail` from a single-line bash command.
 *
 * Bail-out conditions (all preserve the original verbatim):
 *  - command contains any newline (multi-line scripts may legitimately end a
 *    pipeline with `head`/`tail` to bound a generator);
 *  - the matched segment is not the entire command (we never reduce a command
 *    to an empty string);
 *  - the `head`/`tail` carries any flag we don't recognize (e.g. `-f`, `-F`,
 *    `+N`, filenames, redirects) — the regex simply won't match.
 */
export function stripTrailingHeadTail(command: string): BashFixupResult {
	// Single-line guard. We check the raw string for any newline anywhere, not
	// just at the boundary, because shell continuations, heredocs, function
	// bodies, and `for ... done | head` blocks all live behind a newline.
	if (command.includes("\n")) return { command };

	const match = TRAILING_HEAD_TAIL_RE.exec(command);
	if (!match || match.index === undefined) return { command };

	const remainder = command.slice(0, match.index).replace(/[ \t]+$/, "");
	// Never reduce the command to nothing — that would execute as a no-op and
	// almost certainly indicates a false-positive match (e.g. the LLM wrote
	// `head -5` standalone hoping to read its own stdin).
	if (remainder === "") return { command };

	return { command: remainder, stripped: match[0].trim() };
}

/**
 * Human-readable notice for the stripped segment. Mirrors the shape of
 * `formatTimeoutClampNotice` so it can ride alongside the other bash notices.
 */
export function formatHeadTailStripNotice(stripped: string | undefined): string | undefined {
	if (!stripped) return undefined;
	return `Stripped trailing \`${stripped}\` — bash output is truncated automatically and the full result is available via \`artifact://<id>\`.`;
}
