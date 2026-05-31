import type { BeamMemoryState, RecallOptions, RecallResult } from "./beam/types";
import {
	type PolyphonicMemoryResult,
	type PolyphonicRecallOptions,
	polyphonicRecall,
	polyphonicRecallIsEnabled,
} from "./polyphonic-recall";

export interface OrchestratorBeam extends BeamMemoryState {
	recall?: (query: string, topK?: number, options?: RecallOptions) => RecallResult[];
	recallEnhanced?: (query: string, topK?: number, options?: RecallOptions) => RecallResult[];
}

export interface OrchestrateRecallOptions
	extends Omit<RecallOptions, "queryEmbedding">,
		Omit<PolyphonicRecallOptions, "queryEmbedding"> {
	readonly queryEmbedding?: readonly number[] | Float32Array | null;
	readonly enhanced?: boolean;
	readonly forcePolyphonic?: boolean;
	readonly forceLinear?: boolean;
}

export interface OrchestratedRecallResult extends Omit<RecallResult, "metadata" | "score" | "tier"> {
	score?: number;
	metadata?: RecallResult["metadata"];
	tier?: RecallResult["tier"] | PolyphonicMemoryResult["tier"];
	combined_score?: PolyphonicMemoryResult["combined_score"];
	voice_scores?: PolyphonicMemoryResult["voice_scores"];
}

function toLinearRecallOptions(options: OrchestrateRecallOptions): RecallOptions {
	if (options.queryEmbedding instanceof Float32Array) {
		return { ...options, queryEmbedding: Array.from(options.queryEmbedding) };
	}
	return options as RecallOptions;
}

export function orchestrateRecall(
	beam: OrchestratorBeam,
	query: string,
	topK = 20,
	options: OrchestrateRecallOptions = {},
): OrchestratedRecallResult[] {
	if (!options.forceLinear && (options.forcePolyphonic === true || polyphonicRecallIsEnabled())) {
		return polyphonicRecall(beam, query, topK, options);
	}
	const linearOptions = toLinearRecallOptions(options);
	if (options.enhanced === true) {
		if (typeof beam.recallEnhanced === "function") return beam.recallEnhanced(query, topK, linearOptions);
	}
	if (typeof beam.recall === "function") return beam.recall(query, topK, linearOptions);
	return [];
}
