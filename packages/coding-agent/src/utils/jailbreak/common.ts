/**
 * OMK Jailbreak v6 — Utils / Jailbreak Utilities (TypeScript Port)
 * ===================================================================
 * packages/coding-agent/src/utils/jailbreak/common.ts
 *
 * Common utilities: ASR selection, cosine similarity, Levenshtein distance,
 * seed/corpus types, bypass strategy enums.
 *
 * Zero API calls — pure local computation.
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. Constants
// ═══════════════════════════════════════════════════════════════════════════

export const DB_PATH = `${process.env.HOME || "/tmp"}/.omk/agent/jailbreak_v62.db`;

// ═══════════════════════════════════════════════════════════════════════════
// 2. select_best — ASR-based best result selection
// ═══════════════════════════════════════════════════════════════════════════

export interface SelectableResult {
	status: unknown;
	asrEstimate?: number;
}

export function selectBest(results: SelectableResult[], successVal?: unknown): SelectableResult | undefined {
	const valid =
		successVal !== undefined
			? results.filter((r) => r.status === successVal)
			: results.filter((r) => Boolean(r.status));
	if (valid.length === 0) return undefined;
	return valid.reduce((best, r) => ((r.asrEstimate ?? 0) > (best.asrEstimate ?? 0) ? r : best));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cosine Similarity
// ═══════════════════════════════════════════════════════════════════════════

export function cosineSimilarityDense(vec1: number[], vec2: number[]): number {
	let dot = 0;
	let norm1 = 0;
	let norm2 = 0;
	for (let i = 0; i < vec1.length; i++) {
		dot += vec1[i] * vec2[i];
		norm1 += vec1[i] * vec1[i];
		norm2 += vec2[i] * vec2[i];
	}
	if (norm1 === 0 || norm2 === 0) return 0;
	return dot / (Math.sqrt(norm1) * Math.sqrt(norm2) + 1e-8);
}

export function cosineSimilaritySparse(vec1: Record<string, number>, vec2: Record<string, number>): number {
	const keys = new Set([...Object.keys(vec1), ...Object.keys(vec2)]);
	let dot = 0;
	let norm1 = 0;
	let norm2 = 0;
	for (const k of keys) {
		const v1 = vec1[k] ?? 0;
		const v2 = vec2[k] ?? 0;
		dot += v1 * v2;
		norm1 += v1 * v1;
		norm2 += v2 * v2;
	}
	if (norm1 === 0 || norm2 === 0) return 0;
	return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

export function cosineSimilarityMatrix(vectors: number[][]): number[][] {
	const n = vectors.length;
	const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const sim = cosineSimilarityDense(vectors[i], vectors[j]);
			matrix[i][j] = sim;
			matrix[j][i] = sim;
		}
		matrix[i][i] = 1;
	}
	return matrix;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Levenshtein Distance
// ═══════════════════════════════════════════════════════════════════════════

export function levenshteinDistance(s1: string, s2: string): number {
	const m = s1.length;
	const n = s2.length;
	if (m === 0) return n;
	if (n === 0) return m;

	const prev: number[] = Array(n + 1).fill(0);
	const curr: number[] = Array(n + 1).fill(0);

	for (let j = 0; j <= n; j++) prev[j] = j;

	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				prev[j] + 1, // deletion
				curr[j - 1] + 1, // insertion
				prev[j - 1] + cost, // substitution
			);
		}
		for (let j = 0; j <= n; j++) prev[j] = curr[j];
	}
	return curr[n];
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Seed / CoverageFeedback / Corpus types
// ═══════════════════════════════════════════════════════════════════════════

export interface CoverageFeedback {
	newEdges: number;
	totalEdges: number;
	coverageRatio: number;
}

export interface Seed {
	id: string;
	data: string;
	score: number;
	coverage: CoverageFeedback;
	depth: number;
	parentId?: string;
}

export class SeedCorpusManager {
	seeds: Seed[] = [];
	private index = 0;

	add(seed: Seed): void {
		this.seeds.push(seed);
		this.seeds.sort((a, b) => b.score - a.score);
	}

	getNext(): Seed | undefined {
		if (this.seeds.length === 0) return undefined;
		const seed = this.seeds[this.index % this.seeds.length];
		this.index++;
		return seed;
	}

	getBest(): Seed | undefined {
		return this.seeds[0];
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. BypassStrategy / Escalation enums
// ═══════════════════════════════════════════════════════════════════════════

export const BypassStrategy = {
	DISGUISE: "disguise",
	INJECT: "inject",
	TRANSLATE: "translate",
	NARRATIVE: "narrative",
	SEMANTIC_INV: "semantic_inv",
	CODE_METAPHOR: "code_metaphor",
} as const;

export type BypassStrategy = (typeof BypassStrategy)[keyof typeof BypassStrategy];

export const EscalationStage = {
	LOW: 1,
	MEDIUM: 2,
	HIGH: 3,
	CRITICAL: 4,
} as const;

export type EscalationStage = (typeof EscalationStage)[keyof typeof EscalationStage];

export interface EscalationRiskMatrix {
	stage: EscalationStage;
	probability: number;
	impact: number;
	mitigation: string;
}
