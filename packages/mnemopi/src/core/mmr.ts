export interface MmrResult {
	readonly content?: string;
	readonly score?: number;
	readonly [key: string]: unknown;
}

export type SimilarityFn = (textA: string, textB: string) => number;

export function jaccardSimilarity(textA: string, textB: string): number {
	const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(Boolean));
	const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(Boolean));

	if (wordsA.size === 0 || wordsB.size === 0) return 0.0;

	let intersection = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) intersection += 1;
	}

	return intersection / (wordsA.size + wordsB.size - intersection);
}
export function mmrRerank<T extends MmrResult>(
	results: readonly T[],
	lambdaParam = 0.7,
	topK = 10,
	similarityFn: SimilarityFn = jaccardSimilarity,
): T[] {
	const limit = Math.max(0, Math.trunc(topK));
	if (limit <= 0) return [];
	if (results.length <= 1) return results.slice(0, limit);

	const sortedResults = results.slice().sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	const first = sortedResults[0];
	if (first === undefined) return [];

	const selected: T[] = [first];
	const remaining = sortedResults.slice(1);

	while (remaining.length > 0 && selected.length < limit) {
		let bestIdx = 0;
		let bestScore = Number.NEGATIVE_INFINITY;

		for (let idx = 0; idx < remaining.length; idx += 1) {
			const candidate = remaining[idx];
			if (candidate === undefined) continue;

			let maxSimilarity = 0.0;
			const candidateContent = candidate.content ?? "";
			for (const selectedResult of selected) {
				const similarity = similarityFn(candidateContent, selectedResult.content ?? "");
				if (similarity > maxSimilarity) maxSimilarity = similarity;
			}

			const relevance = candidate.score ?? 0;
			const mmrScore = lambdaParam * relevance - (1.0 - lambdaParam) * maxSimilarity;
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIdx = idx;
			}
		}

		const chosen = remaining.splice(bestIdx, 1)[0];
		if (chosen !== undefined) selected.push(chosen);
	}

	if (selected.length < limit) {
		selected.push(...remaining.slice(0, limit - selected.length));
	}

	return selected;
}
