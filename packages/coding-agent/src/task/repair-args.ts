/**
 * Repair double-encoded JSON string arguments for the task tool.
 *
 * Models occasionally JSON-escape a string value twice when emitting a
 * `task` tool call, so an `assignment` that should read
 *
 *     # Role
 *     You are a judge … "describe this" … return —
 *
 * arrives — after the one JSON decode the provider already applied — as the
 * literal text
 *
 *     # Role\nYou are a judge … \"describe this\" … return \u2014
 *
 * i.e. every newline, quote, and unicode character is still backslash-escaped.
 * The subagent then receives that garbled prompt, and the call preview renders
 * one long blob with visible `\n` / `\"` / `\uXXXX`.
 *
 * The *whole-arguments* form of this quirk (the entire `arguments` blob is a
 * JSON string) is already auto-corrected by the validator's JSON-string
 * coercion. This module handles the *per-field* form, where the object parses
 * fine but an individual string value is double-encoded — the validator never
 * fires there because a double-encoded string is still a structurally valid
 * string.
 *
 * This is deliberately scoped to the task tool's natural-language fields
 * (`assignment`, `description`). It is NOT applied to code-bearing
 * tools (write/edit/bash/search), where a backslash or quote is load-bearing
 * and a false-positive unescape would silently corrupt a file or command.
 */
import type { TaskParams } from "./types";

/** A backslash that escapes a structural char — `\"`, `\\`, `\/`, or `\uXXXX`. */
const STRUCTURAL_ESCAPE = /\\(?:["\\/]|u[0-9a-fA-F]{4})/;

/**
 * Whether `value` carries the signature of whole-string double-encoding rather
 * than an incidental escape mention. A lone `\n`/`\t` in an instruction (e.g.
 * "split lines on \n") is far more likely a literal mention than a
 * double-encoded document, so it is left alone; a structural escape (`\"`,
 * `\\`, `\uXXXX`) or two-plus escape sequences indicates a re-escaped payload.
 */
function hasDoubleEncodeSignature(value: string): boolean {
	if (STRUCTURAL_ESCAPE.test(value)) return true;
	let count = 0;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) === 0x5c /* \ */) {
			count += 1;
			if (count >= 2) return true;
			i += 1; // skip the escaped char so `\\` counts once
		}
	}
	return false;
}

/**
 * Return the once-unescaped string when `value` is uniformly double-encoded
 * JSON (a well-formed JSON string body that decodes to a different string);
 * otherwise return `value` unchanged.
 *
 * The `JSON.parse(\`"${value}"\`)` round-trip is the safety net: it only
 * succeeds when *every* backslash begins a valid JSON escape and no bare
 * double-quote exists — exactly the signature of double-encoding. Genuine
 * prose with a Windows path (`C:\Users`), a regex (`\d+`), an embedded quote,
 * or a real (already-decoded) newline makes the parse throw, so the value is
 * returned untouched.
 */
export function repairDoubleEncodedJsonString(value: string): string {
	// Fast path: no backslash → nothing was escaped → the parse can never differ.
	if (!value.includes("\\")) return value;
	if (!hasDoubleEncodeSignature(value)) return value;
	let decoded: unknown;
	try {
		decoded = JSON.parse(`"${value}"`);
	} catch {
		return value;
	}
	return typeof decoded === "string" && decoded !== value ? decoded : value;
}

/**
 * Repair double-encoded prose in task-tool params (`assignment` and
 * `description`). Returns the same reference when nothing changed so callers
 * can cheaply skip work. Defensive against partially-streamed args
 * (missing/undefined fields) so it is safe on the render path as well as on
 * execution.
 */
export function repairTaskParams(params: TaskParams): TaskParams {
	if (params === null || typeof params !== "object") return params;

	const assignment =
		typeof params.assignment === "string" ? repairDoubleEncodedJsonString(params.assignment) : params.assignment;
	const description =
		typeof params.description === "string" ? repairDoubleEncodedJsonString(params.description) : params.description;

	if (assignment === params.assignment && description === params.description) return params;
	return { ...params, assignment, description };
}
