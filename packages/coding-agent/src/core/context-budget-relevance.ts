/**
 * Query-aware relevance scoring for context budget items.
 *
 * Replaces heuristic proxies (description length, isGlobal hardcoding)
 * with token-based coverage scoring that measures semantic overlap
 * between the current query context and each resource item.
 *
 * Design: Coverage-based IR (not Jaccard) — avoids penalizing long
 * descriptions whose large union would dilute the score.
 */

// ---------------------------------------------------------------------------
// Stop words — English + common Korean particles
// ---------------------------------------------------------------------------

const STOP_WORDS: ReadonlySet<string> = new Set([
	// English common stop words
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"to",
	"of",
	"in",
	"on",
	"for",
	"and",
	"or",
	"with",
	"how",
	"i",
	"you",
	"he",
	"she",
	"it",
	"we",
	"they",
	"me",
	"him",
	"her",
	"us",
	"them",
	"my",
	"your",
	"his",
	"its",
	"our",
	"their",
	"this",
	"that",
	"these",
	"those",
	"what",
	"which",
	"who",
	"whom",
	"where",
	"when",
	"why",
	"not",
	"no",
	"nor",
	"so",
	"if",
	"then",
	"than",
	"too",
	"very",
	"just",
	"about",
	"above",
	"after",
	"again",
	"all",
	"also",
	"am",
	"any",
	"because",
	"before",
	"between",
	"both",
	"but",
	"by",
	"from",
	"into",
	"more",
	"most",
	"other",
	"out",
	"over",
	"own",
	"same",
	"some",
	"such",
	"there",
	"up",
	"down",
	"here",
	"at",
	"as",
	"while",
	"through",
	"during",
	"each",
	"few",
	"further",
	"once",
	"only",
	"until",
	// Korean particles (조사)
	"은",
	"는",
	"이",
	"가",
	"을",
	"를",
	"에",
	"의",
	"와",
	"과",
	"도",
	"로",
	"으로",
	"에서",
	"까지",
	"부터",
	"만",
	"라도",
	"나",
	"이며",
	"이고",
	"이나",
	"라",
	"이다",
	"하다",
	"된",
]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize text for relevance scoring.
 *
 * 1. Lowercase
 * 2. Split: Latin words via regex, Korean syllable groups via regex
 * 3. Remove stop words
 * 4. Remove short Latin tokens (<=2 chars)
 * 5. Deduplicate
 */
export function tokenizeForRelevance(text: string): readonly string[] {
	const lower = text.toLowerCase();
	const raw = lower.match(/[\uac00-\ud7a3]+|[a-z0-9]+/g);
	if (!raw) {
		return [];
	}

	const seen = new Set<string>();
	const tokens: string[] = [];

	for (const token of raw) {
		// Skip stop words
		if (STOP_WORDS.has(token)) {
			continue;
		}
		// For Latin tokens, skip very short ones (<=2 chars)
		if (/^[a-z0-9]+$/.test(token) && token.length <= 2) {
			continue;
		}
		// For Korean, keep 2+ syllable groups
		if (/^[\uac00-\ud7a3]+$/.test(token)) {
			if (token.length >= 2 && !seen.has(token)) {
				seen.add(token);
				tokens.push(token);
			}
			continue;
		}
		// Deduplicate
		if (!seen.has(token)) {
			seen.add(token);
			tokens.push(token);
		}
	}

	return tokens;
}

// ---------------------------------------------------------------------------
// Coverage scoring
// ---------------------------------------------------------------------------

/**
 * Compute coverage: fraction of query tokens found in the item token set.
 * Optional per-token weights boost high-value matches (name, path).
 */
function computeCoverage(
	queryTokens: readonly string[],
	itemTokenSet: ReadonlySet<string>,
	itemTokenWeights?: ReadonlyMap<string, number>,
): number {
	if (queryTokens.length === 0) {
		return 0;
	}

	let matchWeight = 0;
	for (const qt of queryTokens) {
		if (itemTokenSet.has(qt)) {
			matchWeight += itemTokenWeights?.get(qt) ?? 1;
		}
	}

	// Normalize: each query token contributes at most 1 to the numerator
	return Math.min(1, matchWeight / queryTokens.length);
}

/**
 * Build a token set with optional high-weight tokens.
 */
function buildWeightedTokenSet(
	baseText: string,
	highWeightText: string | undefined,
	weight: number,
): { tokens: Set<string>; weights: Map<string, number> } {
	const baseTokens = tokenizeForRelevance(baseText);
	const highTokens = highWeightText ? tokenizeForRelevance(highWeightText) : [];

	const tokenSet = new Set<string>();
	const weights = new Map<string, number>();

	for (const t of baseTokens) {
		tokenSet.add(t);
		if (!weights.has(t)) {
			weights.set(t, 1);
		}
	}
	for (const t of highTokens) {
		tokenSet.add(t);
		weights.set(t, Math.max(weights.get(t) ?? 0, weight));
	}

	return { tokens: tokenSet, weights };
}

// ---------------------------------------------------------------------------
// Skill relevance
// ---------------------------------------------------------------------------

const SKILL_NEUTRAL_SCORE = 0.3;
const NAME_MATCH_BONUS = 0.2;
const NAME_TOKEN_WEIGHT = 3;

/**
 * Score skill relevance against a query context.
 *
 * - queryContext undefined or empty -> 0.3 (neutral)
 * - Coverage of query tokens against skill name+description
 * - Name tokens weighted 3x
 * - Name substring match bonus: +0.2 (capped at 1.0)
 */
export function scoreSkillRelevance(
	skill: { readonly name: string; readonly description: string },
	queryContext: string | undefined,
): number {
	if (!queryContext || queryContext.trim() === "") {
		return SKILL_NEUTRAL_SCORE;
	}

	const queryTokens = tokenizeForRelevance(queryContext);
	if (queryTokens.length === 0) {
		return SKILL_NEUTRAL_SCORE;
	}

	// Build skill token set: description is base, name tokens get 3x weight
	const { tokens: skillTokenSet, weights: skillWeights } = buildWeightedTokenSet(
		skill.description,
		skill.name,
		NAME_TOKEN_WEIGHT,
	);

	let score = computeCoverage(queryTokens, skillTokenSet, skillWeights);

	// Name substring bonus: if skill.name appears in query text (or vice versa)
	const queryLower = queryContext.toLowerCase();
	const nameLower = skill.name.toLowerCase();
	if (queryLower.includes(nameLower) || nameLower.includes(queryLower.trim())) {
		score = Math.min(1, score + NAME_MATCH_BONUS);
	}

	return clamp01(score);
}

// ---------------------------------------------------------------------------
// Context file relevance
// ---------------------------------------------------------------------------

const CONTEXT_NEUTRAL_GLOBAL = 0.9;
const CONTEXT_NEUTRAL_LOCAL = 0.6;
const PATH_TOKEN_WEIGHT = 2;
const GLOBAL_BONUS = 0.1;
const CONTENT_SAMPLE_CHARS = 2000;

/**
 * Score context file relevance against a query context.
 *
 * - queryContext undefined -> isGlobal ? 0.9 : 0.6
 * - Coverage of query tokens against path segments + content sample
 * - Path tokens weighted 2x
 * - isGlobal bonus: +0.1
 */
export function scoreContextFileRelevance(
	contextFile: { readonly path: string; readonly content: string; readonly isGlobal: boolean },
	queryContext: string | undefined,
): number {
	if (!queryContext || queryContext.trim() === "") {
		return contextFile.isGlobal ? CONTEXT_NEUTRAL_GLOBAL : CONTEXT_NEUTRAL_LOCAL;
	}

	const queryTokens = tokenizeForRelevance(queryContext);
	if (queryTokens.length === 0) {
		return contextFile.isGlobal ? CONTEXT_NEUTRAL_GLOBAL : CONTEXT_NEUTRAL_LOCAL;
	}

	// Path segments as high-weight text
	const pathText = extractPathSegments(contextFile.path);

	// Content sample for performance
	const contentSample =
		contextFile.content.length > CONTENT_SAMPLE_CHARS
			? contextFile.content.slice(0, CONTENT_SAMPLE_CHARS)
			: contextFile.content;

	// Build token set: content is base, path tokens get 2x weight
	const { tokens: fileTokenSet, weights: fileWeights } = buildWeightedTokenSet(
		contentSample,
		pathText,
		PATH_TOKEN_WEIGHT,
	);

	let score = computeCoverage(queryTokens, fileTokenSet, fileWeights);

	// Global file bonus
	if (contextFile.isGlobal) {
		score = Math.min(1, score + GLOBAL_BONUS);
	}

	return clamp01(score);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract meaningful segments from a file path for token matching.
 */
function extractPathSegments(path: string): string {
	return path
		.toLowerCase()
		.split(/[/\\._-]+/)
		.filter((seg) => seg.length > 0)
		.join(" ");
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
