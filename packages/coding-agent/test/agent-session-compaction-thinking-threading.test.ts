import { describe, expect, test } from "bun:test";

// Audit gate for the compaction-effort fix. The plan calls out three
// production call sites in `agent-session.ts` that MUST thread
// `thinkingLevel: this.thinkingLevel` into the compaction LLM options:
//
//   - `compact(...)` at the manual `/compact` site (`#compactWithFallbackModel`)
//   - `compact(...)` at the auto-compaction site (the most-fired path)
//   - `generateHandoff(...)` at the handoff site
//
// `SummaryOptions.thinkingLevel` is optional, so a future contributor adding
// a new `compact(...)` or `generateHandoff(...)` call without threading it
// would silently fall back to the historical `Effort.High` default — exactly
// the regression Codex caught during plan review (auto-compaction was
// initially missed). The typecheck won't catch this; this test does.

const AGENT_SESSION_PATH = `${import.meta.dir}/../src/session/agent-session.ts`;

// Lines that are NOT direct LLM call sites and don't need threading:
// - The `async compact(...)` method declaration itself.
// - `this.compact(...)` invocations that route through the method (and from
//   there into the threaded `#compactWithFallbackModel`).
const NON_LLM_CALL_PATTERNS = [
	/async compact\(customInstructions/, // method declaration
	/await this\.compact\(/, // self-invocation routes to threaded site
];

interface CallSite {
	line: number;
	headerLine: string;
	callExpression: string;
}

/**
 * Scan source for `compact(` / `generateHandoff(` and extract the
 * brace-balanced call expression for each match. Skips comments,
 * string contents, and non-LLM lines (method declarations, self-calls).
 */
function findCompactionCallSites(src: string): CallSite[] {
	const lines = src.split("\n");
	const sites: CallSite[] = [];

	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx];
		if (!line) continue;
		const headerMatch = /\b(compact|generateHandoff)\(/.exec(line);
		if (!headerMatch) continue;
		if (NON_LLM_CALL_PATTERNS.some(rx => rx.test(line))) continue;
		// Skip lines that are themselves comments
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

		// Compute absolute offset of the opening `(` after the matched name
		let offset = 0;
		for (let l = 0; l < lineIdx; l++) {
			offset += (lines[l]?.length ?? 0) + 1; // +1 for newline
		}
		const openParenIdx = offset + headerMatch.index + headerMatch[0].length - 1;

		// Walk forward, balancing parens. Track string / comment context to
		// avoid counting `(`/`)` inside literals.
		let depth = 0;
		let i = openParenIdx;
		let inString: '"' | "'" | "`" | null = null;
		let inLineComment = false;
		let inBlockComment = false;
		let end = -1;
		for (; i < src.length; i++) {
			const ch = src[i];
			const next = src[i + 1];

			if (inLineComment) {
				if (ch === "\n") inLineComment = false;
				continue;
			}
			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					inBlockComment = false;
					i++;
				}
				continue;
			}
			if (inString) {
				if (ch === "\\") {
					i++;
					continue;
				}
				if (ch === inString) inString = null;
				continue;
			}
			if (ch === "/" && next === "/") {
				inLineComment = true;
				continue;
			}
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				i++;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				inString = ch;
				continue;
			}
			if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}

		if (end === -1) {
			throw new Error(`Unterminated call expression at agent-session.ts:${lineIdx + 1}`);
		}

		sites.push({
			line: lineIdx + 1,
			headerLine: line.trim(),
			callExpression: src.slice(openParenIdx + 1, end),
		});
	}

	return sites;
}

function expressionThreadsThinkingLevel(callExpression: string): boolean {
	// `thinkingLevel:` must appear as a property key — i.e. preceded by `{`
	// or `,` or whitespace + `,` or start of expression, and followed by a
	// value. Loose check via the substring is sufficient because the call
	// expression is brace-balanced (we extracted only one call's contents).
	// We also require the value to be the session field, to defend against
	// `thinkingLevel: undefined` accidentally satisfying the gate.
	return /\bthinkingLevel\s*:\s*this\.thinkingLevel\b/.test(callExpression);
}

describe("agent-session.ts compaction threading (audit gate)", () => {
	test("every direct compact()/generateHandoff() call threads thinkingLevel: this.thinkingLevel", async () => {
		const src = await Bun.file(AGENT_SESSION_PATH).text();
		const sites = findCompactionCallSites(src);
		const offenders = sites.filter(s => !expressionThreadsThinkingLevel(s.callExpression));

		expect(
			offenders,
			`Found ${offenders.length} compaction call site(s) missing 'thinkingLevel: this.thinkingLevel':\n${offenders
				.map(o => `  agent-session.ts:${o.line} — ${o.headerLine}`)
				.join(
					"\n",
				)}\n\nFix: add 'thinkingLevel: this.thinkingLevel' to the options object on every direct compact()/generateHandoff() call. The historical Effort.High default lives in resolveCompactionEffort (packages/agent/src/compaction/compaction.ts) and applies when thinkingLevel is undefined.`,
		).toEqual([]);
	});

	test("at least 3 threaded sites exist (manual /compact + auto-compaction + handoff)", async () => {
		const src = await Bun.file(AGENT_SESSION_PATH).text();
		const sites = findCompactionCallSites(src);
		const threaded = sites.filter(s => expressionThreadsThinkingLevel(s.callExpression));
		// Floor at 3 — the plan explicitly enumerates three sites. If the
		// production surface grows new entry points, the first test fails
		// until they thread too; this guards against accidental removal of
		// any of the original three. Count is derived from the same
		// brace-balanced scanner as the offender check above.
		expect(threaded.length).toBeGreaterThanOrEqual(3);
	});
});
