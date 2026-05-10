import type { EvalLanguage } from "./types";

/**
 * Best-effort language sniff for cells with no explicit `language`.
 *
 * Order:
 * 1. Shebang on first line (`#!/usr/bin/env python`, `#!/usr/bin/env node`, etc.)
 * 2. Strong syntactic markers unique to one language. Bias false negatives over
 *    false positives — anything ambiguous returns `undefined` and the caller
 *    falls back to the default-backend rules.
 */
export function sniffEvalLanguage(code: string): EvalLanguage | undefined {
	const stripped = code.replace(/^\s+/, "");
	if (stripped.startsWith("#!")) {
		const firstLine = stripped.split("\n", 1)[0]!.toLowerCase();
		if (/(\bpython\d?\b|\bipython\b)/.test(firstLine)) return "python";
		if (/(\bnode\b|\bbun\b|\bdeno\b|\bjavascript\b|\bjs\b)/.test(firstLine)) return "js";
	}
	const jsMarkers =
		/(^|\n)\s*(const|let|var|async\s+function|function\s*\*?\s*[\w$]*\s*\(|import\s+[^\n]+\sfrom\s|export\s+(default|const|let|function|class|async)|require\s*\(|console\.\w+\s*\(|=>|;\s*$)/m;
	const pyMarkers =
		/(^|\n)\s*(def\s+\w+\s*\(|from\s+[\w.]+\s+import|import\s+\w+(\s+as\s+\w+)?\s*$|class\s+\w+\s*[(:]|print\s*\(|elif\s+[^\n]*:|with\s+[^\n]+:\s*$|@[\w.]+\s*$)/m;
	const hasJs = jsMarkers.test(code);
	const hasPy = pyMarkers.test(code);
	if (hasJs && !hasPy) return "js";
	if (hasPy && !hasJs) return "python";
	return undefined;
}
