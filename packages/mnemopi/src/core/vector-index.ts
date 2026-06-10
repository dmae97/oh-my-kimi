export interface ExactVectorSearchHit<TId> {
	id: TId;
	score: number;
}

export interface ExactVectorIndex<TId> {
	readonly ids: readonly TId[];
	readonly matrix: Float32Array;
	readonly dimensions: number;
	readonly count: number;
}

export interface VectorIndexRow<TId> {
	id: TId;
	vector: readonly number[] | null | undefined;
}

export function buildExactVectorIndex<TId>(rows: readonly VectorIndexRow<TId>[]): ExactVectorIndex<TId> {
	const valid: Array<{ id: TId; vector: readonly number[]; norm: number }> = [];
	let dimensions = 0;
	for (const row of rows) {
		const vector = row.vector;
		if (!vector || vector.length === 0) continue;
		let normSq = 0;
		for (let i = 0; i < vector.length; i += 1) {
			const value = vector[i] ?? 0;
			if (!Number.isFinite(value)) {
				normSq = 0;
				break;
			}
			normSq += value * value;
		}
		if (normSq <= 0) continue;
		valid.push({ id: row.id, vector, norm: Math.sqrt(normSq) });
		if (vector.length > dimensions) dimensions = vector.length;
	}

	// Float32Array keeps a compact contiguous matrix that matches the shape we'd
	// feed into future ANN/quantized backends. Exact cosine ranking remains sound
	// here because we store normalized vectors and only compare normalized dots.
	const matrix = new Float32Array(valid.length * dimensions);
	const ids: TId[] = [];
	for (let row = 0; row < valid.length; row += 1) {
		const item = valid[row];
		ids.push(item.id);
		const offset = row * dimensions;
		for (let col = 0; col < item.vector.length; col += 1) {
			matrix[offset + col] = (item.vector[col] ?? 0) / item.norm;
		}
	}

	return { ids, matrix, dimensions, count: ids.length };
}

export function searchExactVectorIndex<TId>(
	index: ExactVectorIndex<TId>,
	query: readonly number[],
	limit: number,
): ExactVectorSearchHit<TId>[] {
	const k = Math.max(0, Math.trunc(limit));
	if (k === 0 || index.count === 0 || index.dimensions === 0 || query.length === 0) return [];

	let queryNormSq = 0;
	for (const value of query) {
		if (!Number.isFinite(value)) return [];
		queryNormSq += value * value;
	}
	if (queryNormSq <= 0) return [];
	const queryNorm = Math.sqrt(queryNormSq);
	const queryDimensions = Math.min(query.length, index.dimensions);
	const hits: ExactVectorSearchHit<TId>[] = [];

	for (let row = 0; row < index.count; row += 1) {
		const offset = row * index.dimensions;
		let score = 0;
		for (let col = 0; col < queryDimensions; col += 1) {
			score += index.matrix[offset + col] * ((query[col] ?? 0) / queryNorm);
		}
		hits.push({ id: index.ids[row] as TId, score });
	}

	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, Math.min(k, hits.length));
}
