const COVERAGE_STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"of",
	"to",
	"in",
	"on",
	"for",
	"and",
	"or",
	"is",
	"are",
	"with",
	"how",
	"i",
	"you",
]);

export function computeCoverageGap(
	query: string | undefined,
	selectedTexts: readonly string[],
): { gap: boolean; missing: readonly string[] } {
	if (!query || query.trim() === "") {
		return { gap: false, missing: [] };
	}
	const queryTokens = tokenizeLight(query);
	if (queryTokens.length === 0) {
		return { gap: false, missing: [] };
	}
	const union = new Set<string>();
	for (const text of selectedTexts) {
		for (const token of tokenizeLight(text)) {
			union.add(token);
		}
	}
	const missing = queryTokens.filter((token) => !union.has(token));
	return { gap: missing.length > 0, missing };
}

function tokenizeLight(text: string): readonly string[] {
	const lower = text.toLowerCase();
	const raw = lower.match(/[\p{L}\p{N}\p{Extended_Pictographic}]+/gu);
	if (!raw) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const token of raw) {
		if (isShortAsciiToken(token)) continue;
		if (COVERAGE_STOP_WORDS.has(token)) continue;
		if (!seen.has(token)) {
			seen.add(token);
			out.push(token);
		}
	}
	return out;
}

function isShortAsciiToken(token: string): boolean {
	return token.length <= 2 && /^[a-z0-9]+$/u.test(token);
}
