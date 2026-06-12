/**
 * Model-id classification: parse a model id into its family (gemini / anthropic /
 * openai), kind/variant, and version. This is the shared layer both catalog
 * policy rules (`model-thinking.ts`) and downstream consumers build on —
 * classification lives here, the rules that consume it stay with their domain.
 */

export type SemVer = {
	major: number;
	minor: number;
	patch: number;
};

export type GeminiKind = "pro" | "flash";
export type AnthropicKind = "opus" | "sonnet" | "fable" | "mythos";
export type OpenAIVariant = "base" | "codex" | "codex-max" | "codex-mini" | "codex-spark" | "mini" | "max" | "nano";

export interface GeminiModel {
	family: "gemini";
	kind: GeminiKind;
	version: SemVer;
}

export interface AnthropicModel {
	family: "anthropic";
	kind: AnthropicKind;
	version: SemVer;
}

export interface OpenAIModel {
	family: "openai";
	variant: OpenAIVariant;
	version: SemVer;
}

export interface UnknownModel {
	family: "unknown";
	id: string;
}

export type ParsedModel = GeminiModel | AnthropicModel | OpenAIModel | UnknownModel;

/** Strip a provider namespace prefix (`openai/gpt-5.4` → `gpt-5.4`). */
export function bareModelId(modelId: string): string {
	const p = modelId.lastIndexOf("/");
	return p !== -1 ? modelId.slice(p + 1) : modelId;
}

export function parseKnownModel(modelId: string): ParsedModel {
	const canonicalId = bareModelId(modelId);
	return (
		parseGeminiModel(canonicalId) ??
		parseAnthropicModel(canonicalId) ??
		parseOpenAIModel(canonicalId) ?? { family: "unknown", id: canonicalId }
	);
}

const GEMINI_SUFFIX = "-preview";
export function parseGeminiModel(modelId: string): GeminiModel | null {
	if (modelId.endsWith(GEMINI_SUFFIX)) {
		modelId = modelId.slice(0, -GEMINI_SUFFIX.length);
	}
	const match = /gemini-(\d+(?:\.\d+){0,2})-(pro|flash)\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return { family: "gemini", kind: match[2] as GeminiKind, version };
}

export function parseAnthropicModel(modelId: string): AnthropicModel | null {
	const match = /claude-(opus|sonnet|fable|mythos)-(\d{1,2}(?:[.-]\d{1,2}){0,2})\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[2]);
	if (!version) {
		return null;
	}
	return { family: "anthropic", kind: match[1] as AnthropicKind, version };
}

export function parseOpenAIModel(modelId: string): OpenAIModel | null {
	const match = /gpt-(\d+(?:\.\d+){0,2})(?:-(codex-spark|codex-mini|codex-max|codex|mini|max|nano))?\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return { family: "openai", variant: (match[2] as OpenAIVariant | undefined) ?? "base", version };
}

export function isFableOrMythos(kind: AnthropicKind): boolean {
	return kind === "fable" || kind === "mythos";
}

function createSemVer(major: number, minor: number, patch = 0): SemVer {
	return { major, minor, patch };
}

// extend this table if we need anything more than 9.10
const precomputeTable: Record<string, SemVer> = {};
for (let major = 0; major <= 9; major++) {
	for (let minor = 0; minor <= 10; minor++) {
		const version = createSemVer(major, minor, 0);
		precomputeTable[`${major}.${minor}`] = version;
		precomputeTable[`${major}-${minor}`] = version;
	}
	precomputeTable[`${major}`] = createSemVer(major, 0, 0);
}

export function parseSemVer(version: string): SemVer | null {
	return precomputeTable[version] ?? null;
}

export function semverGte(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) >= 0;
}

export function semverEqual(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) === 0;
}

export function compareSemVer(left: SemVer | string | null, right: SemVer | string | null): number {
	left = typeof left === "string" ? parseSemVer(left) : left;
	right = typeof right === "string" ? parseSemVer(right) : right;
	if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);

	if (left.major !== right.major) {
		return left.major - right.major;
	}
	if (left.minor !== right.minor) {
		return left.minor - right.minor;
	}
	return left.patch - right.patch;
}
