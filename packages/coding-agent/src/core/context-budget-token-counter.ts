import { createRequire } from "node:module";

export type ContextBudgetTokenCountMethod = "exact" | "estimated";
export type ContextBudgetTokenConfidence = "high" | "medium" | "low";
export type ContextBudgetTokenizerMode = "auto" | "fallback" | "openai-js" | "openai-wasm";

export interface TokenCountResult {
	readonly tokens: number;
	readonly method: ContextBudgetTokenCountMethod;
	readonly confidence: ContextBudgetTokenConfidence;
	readonly adapterId: string;
	readonly modelId: string;
	readonly notes: readonly string[];
}

export interface TokenCounterAdapter {
	readonly id: string;
	readonly priority: number;
	isAvailable(): boolean;
	supports(modelId: string): boolean;
	countText(input: string, modelId: string): TokenCountResult;
}

export interface OptionalModuleLoader {
	resolve(specifier: string): string | undefined;
	load(specifier: string): unknown;
}

export interface TokenCounterRegistryOptions {
	readonly adapters?: readonly TokenCounterAdapter[];
	readonly fallback?: TokenCounterAdapter;
}

interface EncodeCapable {
	encode(input: string): readonly unknown[];
}

interface JsTiktokenModule {
	encodingForModel?: (modelId: string) => EncodeCapable;
	getEncoding?: (encoding: string) => EncodeCapable;
}

interface GenericEncodeModule {
	encode?: (input: string) => readonly unknown[];
}

const requireModule = createRequire(import.meta.url);

export function createNodeOptionalModuleLoader(): OptionalModuleLoader {
	return {
		resolve(specifier) {
			try {
				return requireModule.resolve(specifier);
			} catch {
				return undefined;
			}
		},
		load(specifier) {
			return requireModule(specifier) as unknown;
		},
	};
}

export function createFallbackTokenCounter(): TokenCounterAdapter {
	return {
		id: "fallback-estimator",
		priority: 0,
		isAvailable: () => true,
		supports: () => true,
		countText(input, modelId) {
			return estimateTextTokens(input, modelId);
		},
	};
}

export function estimateTextTokens(input: string, modelId = "unknown"): TokenCountResult {
	if (input.length === 0) {
		return createTokenResult(0, "estimated", "medium", "fallback-estimator", modelId, ["empty-input"]);
	}

	let asciiWord = 0;
	let whitespace = 0;
	let cjk = 0;
	let hangul = 0;
	let kana = 0;
	let emojiOrWide = 0;
	let punctuation = 0;
	let other = 0;

	for (const char of input) {
		const codePoint = char.codePointAt(0) ?? 0;
		if (/\s/u.test(char)) {
			whitespace += 1;
		} else if (isHangul(codePoint)) {
			hangul += 1;
		} else if (isHiraganaOrKatakana(codePoint)) {
			kana += 1;
		} else if (isCjkIdeograph(codePoint)) {
			cjk += 1;
		} else if (isAsciiAlphaNumeric(codePoint) || char === "_") {
			asciiWord += 1;
		} else if (isEmojiOrWideSymbol(codePoint)) {
			emojiOrWide += 1;
		} else if (isAsciiPunctuation(codePoint)) {
			punctuation += 1;
		} else {
			other += 1;
		}
	}

	const codeLike = looksCodeLike(input, punctuation, whitespace);
	const jsonLike = looksJsonLike(input);
	const nonAsciiRatio = (hangul + cjk + kana + emojiOrWide + other) / Math.max(1, input.length);
	const base =
		asciiWord / (codeLike ? 3.2 : 4) +
		whitespace / 12 +
		punctuation / 2.1 +
		hangul / 0.95 +
		kana / 1.0 +
		cjk / 1.2 +
		emojiOrWide * 1.8 +
		other / 2;
	const adjusted = base * (jsonLike ? 1.12 : 1) * (codeLike ? 1.08 : 1);
	const tokens = Math.max(1, Math.ceil(adjusted));
	const compositionParts: string[] = [];
	if (hangul > 0) compositionParts.push(`hangul:${hangul}`);
	if (kana > 0) compositionParts.push(`kana:${kana}`);
	if (cjk > 0) compositionParts.push(`cjk:${cjk}`);
	if (asciiWord > 0) compositionParts.push(`ascii:${asciiWord}`);
	if (emojiOrWide > 0) compositionParts.push(`emoji:${emojiOrWide}`);
	const notes = [
		codeLike ? "code-like" : "prose-like",
		jsonLike ? "json-like" : "not-json-like",
		nonAsciiRatio > 0 ? `non-ascii:${(nonAsciiRatio * 100).toFixed(0)}%` : "latin-only",
		`composition(${compositionParts.join(",")})`,
	];
	const confidence: ContextBudgetTokenConfidence =
		nonAsciiRatio > 0.4 ? "low" : nonAsciiRatio > 0.15 ? "medium" : "high";
	return createTokenResult(tokens, "estimated", confidence, "fallback-estimator", modelId, notes);
}

export function createOpenAiJsTokenCounter(
	loader: OptionalModuleLoader = createNodeOptionalModuleLoader(),
): TokenCounterAdapter {
	const packageNames = ["js-tiktoken", "gpt-tokenizer", "tiktoken"] as const;
	return {
		id: "openai-bpe-js",
		priority: 80,
		isAvailable() {
			return packageNames.some((specifier) => loader.resolve(specifier) !== undefined);
		},
		supports(modelId) {
			return isOpenAiStyleModel(modelId);
		},
		countText(input, modelId) {
			for (const specifier of packageNames) {
				if (loader.resolve(specifier) === undefined) {
					continue;
				}
				const result = countWithOptionalTokenizerModule(loader.load(specifier), specifier, input, modelId);
				if (result !== undefined) {
					return result;
				}
			}
			throw new Error("no supported OpenAI JS tokenizer module shape found");
		},
	};
}

export function createOpenAiWasmTokenCounter(
	loader: OptionalModuleLoader = createNodeOptionalModuleLoader(),
): TokenCounterAdapter {
	const packageNames = ["@dqbd/tiktoken", "tiktoken"] as const;
	return {
		id: "openai-bpe-wasm",
		priority: 90,
		isAvailable() {
			return packageNames.some((specifier) => loader.resolve(specifier) !== undefined);
		},
		supports(modelId) {
			return isOpenAiStyleModel(modelId);
		},
		countText(input, modelId) {
			for (const specifier of packageNames) {
				if (loader.resolve(specifier) === undefined) {
					continue;
				}
				const result = countWithOptionalTokenizerModule(loader.load(specifier), specifier, input, modelId);
				if (result !== undefined) {
					return result;
				}
			}
			throw new Error("no supported OpenAI WASM tokenizer module shape found");
		},
	};
}

export function createTokenCounterForMode(
	mode: ContextBudgetTokenizerMode,
	loader: OptionalModuleLoader = createNodeOptionalModuleLoader(),
): TokenCounterAdapter {
	const fallback = createFallbackTokenCounter();
	if (mode === "fallback") {
		return fallback;
	}
	const adapters =
		mode === "openai-wasm" ? [createOpenAiWasmTokenCounter(loader)] : [createOpenAiJsTokenCounter(loader)];
	if (mode === "auto") {
		adapters.push(createOpenAiWasmTokenCounter(loader));
	}
	return createTokenCounterRegistry({ adapters, fallback });
}

export function createTokenCounterRegistry(options: TokenCounterRegistryOptions = {}): TokenCounterAdapter {
	const fallback = options.fallback ?? createFallbackTokenCounter();
	const adapters = [...(options.adapters ?? [])].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
	return {
		id: "token-counter-registry",
		priority: 100,
		isAvailable: () => true,
		supports: () => true,
		countText(input, modelId) {
			const notes: string[] = [];
			for (const adapter of adapters) {
				if (!adapter.supports(modelId)) {
					continue;
				}
				try {
					if (!adapter.isAvailable()) {
						notes.push(`${adapter.id}:unavailable`);
						continue;
					}
					return adapter.countText(input, modelId);
				} catch (error) {
					const message = error instanceof Error ? error.message : "unknown adapter failure";
					notes.push(`${adapter.id}:failed:${message}`);
				}
			}
			const result = fallback.countText(input, modelId);
			return { ...result, notes: [...notes, ...result.notes] };
		},
	};
}

function countWithOptionalTokenizerModule(
	moduleValue: unknown,
	specifier: string,
	input: string,
	modelId: string,
): TokenCountResult | undefined {
	const moduleObject = unwrapDefaultModule(moduleValue);
	const jsTiktoken = moduleObject as JsTiktokenModule;
	if (typeof jsTiktoken.encodingForModel === "function") {
		const encoding = jsTiktoken.encodingForModel(modelId);
		return countWithEncoding(encoding, specifier, input, modelId, "model-encoding");
	}
	if (typeof jsTiktoken.getEncoding === "function") {
		const encoding = jsTiktoken.getEncoding(selectOpenAiEncoding(modelId));
		return countWithEncoding(encoding, specifier, input, modelId, "fallback-encoding");
	}
	const generic = moduleObject as GenericEncodeModule;
	if (typeof generic.encode === "function") {
		return createTokenResult(generic.encode(input).length, "exact", "medium", specifier, modelId, ["generic-encode"]);
	}
	return undefined;
}

function countWithEncoding(
	encoding: EncodeCapable,
	adapterId: string,
	input: string,
	modelId: string,
	note: string,
): TokenCountResult {
	return createTokenResult(encoding.encode(input).length, "exact", "high", adapterId, modelId, [note]);
}

function unwrapDefaultModule(moduleValue: unknown): unknown {
	if (moduleValue && typeof moduleValue === "object" && "default" in moduleValue) {
		return (moduleValue as { readonly default: unknown }).default;
	}
	return moduleValue;
}

function createTokenResult(
	tokens: number,
	method: ContextBudgetTokenCountMethod,
	confidence: ContextBudgetTokenConfidence,
	adapterId: string,
	modelId: string,
	notes: readonly string[],
): TokenCountResult {
	return {
		tokens: Math.max(0, Math.ceil(tokens)),
		method,
		confidence,
		adapterId,
		modelId,
		notes,
	};
}

function isOpenAiStyleModel(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return (
		normalized.includes("openai") ||
		normalized.startsWith("gpt-") ||
		normalized.startsWith("o1") ||
		normalized.startsWith("o3") ||
		normalized.startsWith("o4") ||
		normalized.includes("chatgpt")
	);
}

function selectOpenAiEncoding(modelId: string): string {
	const normalized = modelId.toLowerCase();
	if (normalized.includes("gpt-4o") || normalized.includes("gpt-5") || normalized.startsWith("o")) {
		return "o200k_base";
	}
	return "cl100k_base";
}

function isAsciiAlphaNumeric(codePoint: number): boolean {
	return (
		(codePoint >= 48 && codePoint <= 57) ||
		(codePoint >= 65 && codePoint <= 90) ||
		(codePoint >= 97 && codePoint <= 122)
	);
}

function isAsciiPunctuation(codePoint: number): boolean {
	return codePoint >= 33 && codePoint <= 126;
}

function isHangul(codePoint: number): boolean {
	// Composed syllables (가-힣)
	if (codePoint >= 0xac00 && codePoint <= 0xd7af) return true;
	// Jamo: initial (ㄱ-ㅎ), medial (ㅏ-ㅣ)
	if (codePoint >= 0x1100 && codePoint <= 0x11ff) return true;
	// Compatibility jamo (ㄱ-ㅎ, ㅏ-ㅣ) and Hangul letters
	if (codePoint >= 0x3130 && codePoint <= 0x318f) return true;
	// Extended jamo
	if (codePoint >= 0xa960 && codePoint <= 0xa97c) return true;
	return false;
}

function isHiraganaOrKatakana(codePoint: number): boolean {
	// Hiragana (ぁ-より)
	if (codePoint >= 0x3040 && codePoint <= 0x309f) return true;
	// Katakana (ァ-ヿ) + halfwidth katakana
	if (codePoint >= 0x30a0 && codePoint <= 0x30ff) return true;
	if (codePoint >= 0xff65 && codePoint <= 0xff9f) return true;
	return false;
}

function isCjkIdeograph(codePoint: number): boolean {
	// CJK Unified Ideographs (main block: 中, 国, etc.)
	if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return true;
	// CJK Extension A (rare)
	if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return true;
	// CJK compatibility ideographs
	if (codePoint >= 0xf900 && codePoint <= 0xfaff) return true;
	return false;
}

function isEmojiOrWideSymbol(codePoint: number): boolean {
	// Main emoji blocks
	if (codePoint >= 0x1f000) return true;
	// Misc symbols, dingbats
	if (codePoint >= 0x2600 && codePoint <= 0x27bf) return true;
	// CJK fullwidth/special forms that occupy double width
	if (codePoint >= 0xff01 && codePoint <= 0xff60) return true;
	if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return true;
	return false;
}

function looksJsonLike(input: string): boolean {
	const trimmed = input.trim();
	return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function looksCodeLike(input: string, punctuation: number, whitespace: number): boolean {
	if (/\b(function|const|let|class|interface|import|export|return|async|await)\b/.test(input)) {
		return true;
	}
	return punctuation > input.length / 8 && whitespace > input.length / 20;
}
