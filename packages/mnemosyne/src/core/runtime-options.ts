import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, Model } from "@oh-my-pi/pi-ai";

export interface MnemosyneLlmCompleteOptions {
	maxTokens?: number;
	temperature?: number;
	timeout?: number;
	provider?: string | null;
	model?: string | null;
}

export type MnemosyneLlmCompletion = (
	prompt: string,
	opts?: MnemosyneLlmCompleteOptions,
) => string | null | Promise<string | null>;

/** A single embedding row as a provider may emit it: a packed `Float32Array` or plain numbers. */
export type EmbeddingRow = Float32Array | readonly number[];

/**
 * Everything an embedding provider's `embed` is allowed to return. Rows come back either directly as
 * a flat list, or in batches (each batch a list of rows) through a sync or async iterable — fastembed's
 * `embed()` is an `AsyncGenerator<number[][]>`. Non-array / non-finite values are rejected at runtime.
 */
export type EmbeddingOutput =
	| Iterable<EmbeddingRow | readonly EmbeddingRow[]>
	| AsyncIterable<EmbeddingRow | readonly EmbeddingRow[]>;

export interface MnemosyneEmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export interface MnemosyneEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: string;
	provider?: MnemosyneEmbeddingProvider | ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>);
}

export interface MnemosyneLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: string;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: MnemosyneLlmCompletion;
	/** Override the fact-extraction prompt template ({text}/{lang}). Used to feed small local models a friendlier format. */
	extractionPrompt?: string;
	/** Override the consolidation/sleep prompt template ({memories}/{source}/{memory_count}). */
	consolidationPrompt?: string;
}

export interface MnemosyneRuntimeOptions {
	embeddings?: false | MnemosyneEmbeddingRuntimeOptions;
	llm?: false | MnemosyneLlmRuntimeOptions | Model<Api> | MnemosyneLlmCompletion;
}

export interface ResolvedMnemosyneEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: string;
	provider?: MnemosyneEmbeddingProvider;
}

export interface ResolvedMnemosyneLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: string;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: MnemosyneLlmCompletion;
	extractionPrompt?: string;
	consolidationPrompt?: string;
}

export interface ResolvedMnemosyneRuntimeOptions {
	embeddings?: ResolvedMnemosyneEmbeddingRuntimeOptions;
	llm?: ResolvedMnemosyneLlmRuntimeOptions;
}

const runtimeOptionsStorage = new AsyncLocalStorage<ResolvedMnemosyneRuntimeOptions>();

export function withMnemosyneRuntimeOptions<T>(options: ResolvedMnemosyneRuntimeOptions | undefined, fn: () => T): T {
	if (options === undefined) {
		return fn();
	}
	return runtimeOptionsStorage.run(options, fn);
}

export function getMnemosyneRuntimeOptions(): ResolvedMnemosyneRuntimeOptions | undefined {
	return runtimeOptionsStorage.getStore();
}

export function resolveEmbeddingProvider(
	provider:
		| MnemosyneEmbeddingProvider
		| ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>)
		| undefined,
): MnemosyneEmbeddingProvider | undefined {
	if (provider === undefined) {
		return undefined;
	}
	if (typeof provider === "function") {
		return { embed: provider };
	}
	return provider;
}

export function isPiAiModel(value: unknown): value is Model<Api> {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const maybe = value as Partial<Model<Api>>;
	return (
		typeof maybe.id === "string" &&
		typeof maybe.provider === "string" &&
		typeof maybe.baseUrl === "string" &&
		typeof maybe.api === "string"
	);
}
