import { type Api, getBundledModels, getBundledProviders, type Model } from "@oh-my-pi/pi-ai";

export type CanonicalModelSource = "override" | "bundled" | "heuristic" | "fallback";

export interface ModelEquivalenceConfig {
	overrides?: Record<string, string>;
	exclude?: string[];
}

export interface CanonicalModelVariant {
	canonicalId: string;
	selector: string;
	model: Model<Api>;
	source: CanonicalModelSource;
}

export interface CanonicalModelRecord {
	id: string;
	name: string;
	variants: CanonicalModelVariant[];
}

export interface CanonicalModelIndex {
	records: CanonicalModelRecord[];
	byId: Map<string, CanonicalModelRecord>;
	bySelector: Map<string, string>;
}

interface CanonicalReferenceData {
	references: Map<string, Model<Api>>;
	officialIds: Set<string>;
}

interface CompiledEquivalenceConfig {
	overrides: Map<string, string>;
	exclude: Set<string>;
}

interface ResolvedCanonicalModel {
	id: string;
	source: CanonicalModelSource;
}

const TRAILING_CANONICAL_MARKERS = [
	"thinking",
	"customtools",
	"high",
	"low",
	"medium",
	"minimal",
	"xhigh",
	"free",
	"exacto",
	"nitro",
	"original",
	"optimized",
	"nvfp4",
	"fp8",
	"fp4",
	"bf16",
	"int8",
	"int4",
] as const;
const TRAILING_MARKER_SUFFIXES: readonly string[] = (() => {
	const suffixes: string[] = [];
	for (const marker of TRAILING_CANONICAL_MARKERS) {
		const lower = marker.toLowerCase();
		suffixes.push(`-${lower}`, `:${lower}`);
	}
	return suffixes;
})();
const WRAPPER_PREFIXES = ["duo-chat-"] as const;

let __referenceDataCache: CanonicalReferenceData | undefined;
const EMPTY_COMPILED_EQUIVALENCE: CompiledEquivalenceConfig = {
	overrides: new Map<string, string>(),
	exclude: new Set<string>(),
};
const __resolutionCache: WeakMap<
	CompiledEquivalenceConfig,
	WeakMap<Model<Api>, ResolvedCanonicalModel>
> = new WeakMap();
const FAMILY_EXTRACTION_PATTERNS = [
	/(?:^|[/:._-])((?:claude|gemini|gpt|grok|glm|qwen|minimax|kimi|deepseek|llama|gemma|nova|mistral|ministral|pixtral|codestral|devstral|magistral|ernie|doubao|seed|aion|olmo|molmo|nemotron|palmyra|command|codex|coder|o[1345])[-a-z0-9.]+)(?::|$)/i,
	/(?:^|[/:._-])((?:claude|gemini|gpt|grok|glm|qwen|minimax|kimi|deepseek|llama|gemma|nova|mistral|ministral|pixtral|codestral|devstral|magistral|ernie|doubao|seed|aion|olmo|molmo|nemotron|palmyra|command|codex|coder|o[1345])[-a-z0-9.]+(?:[-_/][a-z0-9.]+)*)(?::|$)/i,
] as const;

function shouldReplaceReference(existing: Model<Api> | undefined, candidate: Model<Api>): boolean {
	if (!existing) return true;
	if (candidate.contextWindow !== existing.contextWindow) {
		return candidate.contextWindow > existing.contextWindow;
	}
	if (candidate.maxTokens !== existing.maxTokens) {
		return candidate.maxTokens > existing.maxTokens;
	}
	return existing.provider !== "openai" && candidate.provider === "openai";
}

function createCanonicalReferenceData(): CanonicalReferenceData {
	if (__referenceDataCache) {
		return __referenceDataCache;
	}
	const references = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0])) {
			const candidate = model as Model<Api>;
			const existing = references.get(candidate.id);
			if (shouldReplaceReference(existing, candidate)) {
				references.set(candidate.id, candidate);
			}
		}
	}
	const officialIds = new Set(references.keys());
	__referenceDataCache = {
		references: Object.freeze(references) as Map<string, Model<Api>>,
		officialIds: Object.freeze(officialIds) as Set<string>,
	};
	return __referenceDataCache;
}

function normalizeSelectorKey(selector: string): string {
	return selector.trim().toLowerCase();
}

function normalizeCanonicalIdKey(canonicalId: string): string {
	return canonicalId.trim().toLowerCase();
}

export function formatCanonicalVariantSelector(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function buildOverrideMap(overrides: Record<string, string> | undefined): Map<string, string> {
	const result = new Map<string, string>();
	if (!overrides) {
		return result;
	}
	for (const [selector, canonicalId] of Object.entries(overrides)) {
		const normalizedSelector = normalizeSelectorKey(selector);
		const normalizedCanonicalId = canonicalId.trim();
		if (!normalizedSelector || !normalizedCanonicalId) {
			continue;
		}
		result.set(normalizedSelector, normalizedCanonicalId);
	}
	return result;
}

function buildExclusionSet(exclusions: readonly string[] | undefined): Set<string> {
	const result = new Set<string>();
	for (const selector of exclusions ?? []) {
		const normalized = normalizeSelectorKey(selector);
		if (normalized) {
			result.add(normalized);
		}
	}
	return result;
}

function compileEquivalenceConfig(config: ModelEquivalenceConfig | undefined): CompiledEquivalenceConfig {
	const overrides = buildOverrideMap(config?.overrides);
	const exclude = buildExclusionSet(config?.exclude);
	if (overrides.size === 0 && exclude.size === 0) {
		return EMPTY_COMPILED_EQUIVALENCE;
	}
	return { overrides, exclude };
}

function addCanonicalCandidate(candidates: Set<string>, candidate: string): void {
	const normalized = candidate.trim();
	if (normalized) {
		candidates.add(normalized);
	}
}

function stripTrailingMarker(candidate: string): string | undefined {
	const lower = candidate.toLowerCase();
	for (const suffix of TRAILING_MARKER_SUFFIXES) {
		if (lower.endsWith(suffix)) {
			return candidate.slice(0, -suffix.length);
		}
	}
	return undefined;
}

function lowercaseCandidate(candidate: string): string | undefined {
	const lowercased = candidate.toLowerCase();
	return lowercased !== candidate ? lowercased : undefined;
}

function stripSyntheticPrefix(candidate: string): string | undefined {
	const stripped = candidate.replace(/^hf:/i, "");
	return stripped !== candidate ? stripped : undefined;
}

function stripLatestSuffix(candidate: string): string | undefined {
	const stripped = candidate.replace(/-latest$/i, "");
	return stripped !== candidate ? stripped : undefined;
}

function stripLegacyGlmTurboSuffix(candidate: string): string | undefined {
	const stripped = candidate.replace(/^(glm-4(?:\.\d+)?v?)-turbo$/i, "$1");
	return stripped !== candidate ? stripped : undefined;
}

function reorderAnthropicFamily(candidate: string): string | undefined {
	const match = /^claude-(\d+(?:[.-]\d+)+)-(opus|sonnet|haiku)$/i.exec(candidate);
	if (!match) {
		return undefined;
	}
	const [, version, family] = match;
	return `claude-${family.toLowerCase()}-${version}`;
}

function stripProviderVersionSuffix(candidate: string): string | undefined {
	const stripped = candidate.replace(/-v\d+(?::\d+)?$/i, "");
	return stripped !== candidate ? stripped : undefined;
}

function stripDateSuffix(candidate: string): string | undefined {
	const stripped = candidate.replace(/-\d{8}$/i, "");
	return stripped !== candidate ? stripped : undefined;
}

function insertAttachedFamilyVersionSeparator(candidate: string): string | undefined {
	const inserted = candidate.replace(
		/(^|[/:._-])((?:claude|gemini|gpt|grok|glm|qwen|minimax|kimi|deepseek|llama|gemma|nova|mistral|ministral|pixtral|codestral|devstral|magistral|ernie|doubao|seed|aion|olmo|molmo|nemotron|palmyra|command|codex|coder))(\d+(?:[.-]\d+)*)(?=$|[-_/.:a-z])/gi,
		"$1$2-$3",
	);
	return inserted !== candidate ? inserted : undefined;
}

function toggleSeriesMinorVersionSeparators(candidate: string): string[] {
	const toggled = new Set<string>();
	const dotToDash = candidate.replace(/(^|[/:._-])([a-z])(\d)\.(\d)(?=$|[-_/.:a-z])/gi, "$1$2$3-$4");
	if (dotToDash !== candidate) {
		toggled.add(dotToDash);
	}
	const dashToDot = candidate.replace(/(^|[/:._-])([a-z])(\d)-(\d)(?=$|[-_/.:a-z])/gi, "$1$2$3.$4");
	if (dashToDot !== candidate) {
		toggled.add(dashToDot);
	}
	return [...toggled];
}

function expandCompactSeriesMinorVersions(candidate: string): string[] {
	const expanded = new Set<string>();
	const compactToDash = candidate.replace(/(^|[/:._-])([a-z])(\d)(\d)(?=$|[-_/.:a-z])/gi, "$1$2$3-$4");
	if (compactToDash !== candidate) {
		expanded.add(compactToDash);
	}
	const compactToDot = candidate.replace(/(^|[/:._-])([a-z])(\d)(\d)(?=$|[-_/.:a-z])/gi, "$1$2$3.$4");
	if (compactToDot !== candidate) {
		expanded.add(compactToDot);
	}
	return [...expanded];
}

function getQualifiedNamespaceSuffixes(candidate: string): string[] {
	const results = new Set<string>();
	for (let index = 1; index < candidate.length; index += 1) {
		if (!/[/:.]/.test(candidate[index - 1]!)) {
			continue;
		}
		const suffix = candidate.slice(index);
		if (suffix.length < 4) {
			continue;
		}
		if (!/[a-z]/i.test(suffix) || !/\d/.test(suffix)) {
			continue;
		}
		addCanonicalCandidate(results, suffix);
	}
	return [...results];
}

function extractUpstreamFamilyCandidate(candidate: string): string | undefined {
	for (const pattern of FAMILY_EXTRACTION_PATTERNS) {
		const match = pattern.exec(candidate);
		if (match?.[1]) {
			return match[1];
		}
	}
	return undefined;
}

function getCandidatePenalty(candidate: string): number {
	let penalty = 0;
	if (candidate.includes("/")) {
		penalty += 100;
	}
	if (candidate.includes(":")) {
		penalty += 40;
	}
	if (/-\d{8}$/i.test(candidate)) {
		penalty += 25;
	}
	if (/-v\d+(?::\d+)?$/i.test(candidate)) {
		penalty += 25;
	}
	if (stripTrailingMarker(candidate)) {
		penalty += 20;
	}
	if (/[A-Z]/.test(candidate)) {
		penalty += 10;
	}
	if (/^claude-\d/i.test(candidate)) {
		penalty += 20;
	}
	if (/^claude-(?:opus|sonnet|haiku)-\d{2}(?=$|[-_a-z])/i.test(candidate)) {
		penalty += 10;
	}
	if (/(?:^|[/:._-])[a-z]\d-\d(?=$|[-_/.:a-z])/i.test(candidate)) {
		penalty += 6;
	}
	if (/(?:^|[-_/])\d-\d(?=$|[-_a-z])/.test(candidate) && !/^claude-(?:opus|sonnet|haiku)-\d-\d/i.test(candidate)) {
		penalty += 4;
	}
	penalty += candidate.length * 0.01;
	return penalty;
}

function compareCandidatePreference(left: string, right: string): number {
	const penaltyDiff = getCandidatePenalty(left) - getCandidatePenalty(right);
	if (penaltyDiff !== 0) {
		return penaltyDiff;
	}
	if (left.length !== right.length) {
		return left.length - right.length;
	}
	return left.localeCompare(right);
}

function selectBestOfficialCandidate(candidates: readonly string[]): string | undefined {
	if (candidates.length === 0) {
		return undefined;
	}
	const ranked = [...new Set(candidates)].sort(compareCandidatePreference);
	return ranked[0];
}

function getWrapperCanonicalCandidates(candidate: string): string[] {
	const results = new Set<string>();
	for (const prefix of WRAPPER_PREFIXES) {
		if (!candidate.toLowerCase().startsWith(prefix)) {
			continue;
		}
		const stripped = candidate.slice(prefix.length);
		addCanonicalCandidate(results, stripped);
		if (/^(opus|sonnet|haiku)-/i.test(stripped)) {
			addCanonicalCandidate(results, `claude-${stripped}`);
		}
	}
	return [...results];
}

function getAnthropicAliasOfficial(candidate: string, officialIds: Set<string>): string | undefined {
	const reordered = reorderAnthropicFamily(candidate);
	if (!reordered) {
		return undefined;
	}
	const candidates = [reordered, ...toggleShortVersionSeparators(reordered)].filter(officialId =>
		officialIds.has(officialId),
	);
	return selectBestOfficialCandidate(candidates);
}

function compareVersionSegments(left: readonly number[], right: readonly number[]): number {
	const maxLength = Math.max(left.length, right.length);
	for (let index = 0; index < maxLength; index += 1) {
		const diff = (left[index] ?? Number.NEGATIVE_INFINITY) - (right[index] ?? Number.NEGATIVE_INFINITY);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

function parseClaudeFamilyVersionSegments(candidate: string, prefix: string): number[] {
	const normalizedCandidate = candidate.toLowerCase();
	const normalizedPrefix = prefix.toLowerCase();
	if (!normalizedCandidate.startsWith(`${normalizedPrefix}-`)) {
		return [];
	}
	const rawSuffix = normalizedCandidate.slice(normalizedPrefix.length + 1);
	if (!rawSuffix) {
		return [];
	}
	const versionSegments: number[] = [];
	for (const token of rawSuffix.split("-")) {
		if (!token) {
			break;
		}
		if (/^\d{8}$/.test(token)) {
			break;
		}
		if (/^\d{2}$/.test(token)) {
			versionSegments.push(Number(token[0]), Number(token[1]));
			continue;
		}
		if (/^\d+(?:\.\d+)*$/.test(token)) {
			versionSegments.push(...token.split(".").map(part => Number(part)));
			continue;
		}
		break;
	}
	return versionSegments;
}

function getClaudeFamilyAliasOfficial(candidate: string, officialIds: Set<string>): string | undefined {
	const match = /^(?:anthropic\/)?(claude(?:-\d(?:[.-]\d+)?)?-(?:haiku|opus|sonnet))(?:-latest)?$/i.exec(candidate);
	if (!match?.[1]) {
		return undefined;
	}
	const familyPrefix = match[1].toLowerCase();
	const familyMatches = [...officialIds].filter(officialId => {
		const normalizedOfficialId = officialId.toLowerCase();
		return normalizedOfficialId.startsWith(`${familyPrefix}-`) || normalizedOfficialId === familyPrefix;
	});
	if (familyMatches.length === 0) {
		return undefined;
	}
	return [...familyMatches].sort((left, right) => {
		const versionDiff = compareVersionSegments(
			parseClaudeFamilyVersionSegments(right, familyPrefix),
			parseClaudeFamilyVersionSegments(left, familyPrefix),
		);
		if (versionDiff !== 0) {
			return versionDiff;
		}
		const leftHasDate = /-\d{8}(?:$|-)/i.test(left);
		const rightHasDate = /-\d{8}(?:$|-)/i.test(right);
		if (leftHasDate !== rightHasDate) {
			return leftHasDate ? 1 : -1;
		}
		const leftHasMarker = stripTrailingMarker(left) !== undefined;
		const rightHasMarker = stripTrailingMarker(right) !== undefined;
		if (leftHasMarker !== rightHasMarker) {
			return leftHasMarker ? 1 : -1;
		}
		return compareCandidatePreference(left, right);
	})[0];
}

function toggleShortVersionSeparators(candidate: string): string[] {
	const toggled = new Set<string>();
	const dotToDash = candidate.replace(/(^|[-_/])(\d{1,2})\.(\d{1,2})(?=$|[-_a-z])/gi, "$1$2-$3");
	if (dotToDash !== candidate) {
		toggled.add(dotToDash);
	}
	const dashToDot = candidate.replace(/(^|[-_/])(\d{1,2})-(\d{1,2})(?=$|[-_a-z])/gi, "$1$2.$3");
	if (dashToDot !== candidate) {
		toggled.add(dashToDot);
	}
	return [...toggled];
}

function expandCompactMinorVersions(candidate: string): string[] {
	const expanded = new Set<string>();
	const compactToDash = candidate.replace(/(^|[-_/])(\d)(\d)(?=$|[-_a-z])/g, "$1$2-$3");
	if (compactToDash !== candidate) {
		expanded.add(compactToDash);
	}
	const compactToDot = candidate.replace(/(^|[-_/])(\d)(\d)(?=$|[-_a-z])/g, "$1$2.$3");
	if (compactToDot !== candidate) {
		expanded.add(compactToDot);
	}
	return [...expanded];
}

function getHeuristicCanonicalCandidates(modelId: string): string[] {
	const candidates = new Set<string>();
	const queue = [modelId];
	const visited = new Set<string>();

	for (let qi = 0; qi < queue.length; qi += 1) {
		const candidate = queue[qi];
		if (!candidate) {
			continue;
		}
		const normalized = candidate.trim();
		if (!normalized || visited.has(normalized)) {
			continue;
		}
		visited.add(normalized);
		addCanonicalCandidate(candidates, normalized);

		const lowercased = lowercaseCandidate(normalized);
		if (lowercased) {
			queue.push(lowercased);
		}

		const pathSegments = normalized.split("/");
		for (let index = 1; index < pathSegments.length; index += 1) {
			queue.push(pathSegments.slice(index).join("/"));
		}

		for (const suffix of getQualifiedNamespaceSuffixes(normalized)) {
			queue.push(suffix);
		}

		for (const toggled of toggleShortVersionSeparators(normalized)) {
			queue.push(toggled);
		}

		const attachedFamilyVersion = insertAttachedFamilyVersionSeparator(normalized);
		if (attachedFamilyVersion) {
			queue.push(attachedFamilyVersion);
		}

		for (const toggledSeriesVersion of toggleSeriesMinorVersionSeparators(normalized)) {
			queue.push(toggledSeriesVersion);
		}

		for (const expandedVersion of expandCompactMinorVersions(normalized)) {
			queue.push(expandedVersion);
		}

		for (const expandedSeriesVersion of expandCompactSeriesMinorVersions(normalized)) {
			queue.push(expandedSeriesVersion);
		}

		for (const wrapperCandidate of getWrapperCanonicalCandidates(normalized)) {
			queue.push(wrapperCandidate);
		}

		const strippedSyntheticPrefix = stripSyntheticPrefix(normalized);
		if (strippedSyntheticPrefix) {
			queue.push(strippedSyntheticPrefix);
		}

		const strippedLatest = stripLatestSuffix(normalized);
		if (strippedLatest) {
			queue.push(strippedLatest);
		}

		const strippedLegacyGlmTurbo = stripLegacyGlmTurboSuffix(normalized);
		if (strippedLegacyGlmTurbo) {
			queue.push(strippedLegacyGlmTurbo);
		}

		const extractedFamily = extractUpstreamFamilyCandidate(normalized);
		if (extractedFamily) {
			queue.push(extractedFamily);
		}

		const strippedProviderVersion = stripProviderVersionSuffix(normalized);
		if (strippedProviderVersion) {
			queue.push(strippedProviderVersion);
		}

		const strippedDate = stripDateSuffix(normalized);
		if (strippedDate) {
			queue.push(strippedDate);
		}

		const strippedMarker = stripTrailingMarker(normalized);
		if (strippedMarker) {
			queue.push(strippedMarker);
		}

		const reorderedAnthropic = reorderAnthropicFamily(normalized);
		if (reorderedAnthropic) {
			queue.push(reorderedAnthropic);
		}
	}

	return [...candidates];
}

function getPreferredFallbackCanonicalCandidate(modelId: string, candidates: readonly string[]): string | undefined {
	if (!/[/:.]/.test(modelId)) {
		return undefined;
	}
	const cleanCandidates = candidates.filter(candidate => {
		if (!candidate || candidate === modelId) {
			return false;
		}
		if (candidate.includes("/") || candidate.includes(":")) {
			return false;
		}
		if (candidate.toLowerCase() !== candidate) {
			return false;
		}
		const extractedFamily = extractUpstreamFamilyCandidate(candidate);
		return extractedFamily?.toLowerCase() === candidate;
	});
	return selectBestOfficialCandidate(cleanCandidates);
}

function resolveCanonicalIdForModel(
	model: Model<Api>,
	equivalence: CompiledEquivalenceConfig,
	referenceData: CanonicalReferenceData,
): ResolvedCanonicalModel {
	const selector = formatCanonicalVariantSelector(model);
	const normalizedSelector = normalizeSelectorKey(selector);

	if (equivalence.overrides.has(normalizedSelector)) {
		return { id: equivalence.overrides.get(normalizedSelector)!, source: "override" };
	}

	if (equivalence.exclude.has(normalizedSelector)) {
		return { id: model.id, source: "fallback" };
	}

	const anthropicAlias = getAnthropicAliasOfficial(model.id, referenceData.officialIds);
	if (anthropicAlias) {
		return { id: anthropicAlias, source: anthropicAlias === model.id ? "bundled" : "heuristic" };
	}

	const claudeFamilyAlias = getClaudeFamilyAliasOfficial(model.id, referenceData.officialIds);
	if (claudeFamilyAlias) {
		return { id: claudeFamilyAlias, source: claudeFamilyAlias === model.id ? "bundled" : "heuristic" };
	}

	const heuristicCandidates = getHeuristicCanonicalCandidates(model.id);
	const officialMatches = heuristicCandidates.filter(candidate => referenceData.officialIds.has(candidate));
	const preferredFallback = getPreferredFallbackCanonicalCandidate(model.id, heuristicCandidates);
	const match = selectBestOfficialCandidate(officialMatches);
	if (match) {
		if (
			preferredFallback &&
			(match.includes("/") || match.includes(":")) &&
			compareCandidatePreference(preferredFallback, match) < 0
		) {
			return { id: preferredFallback, source: "heuristic" };
		}
		return { id: match, source: match === model.id ? "bundled" : "heuristic" };
	}

	if (preferredFallback) {
		return { id: preferredFallback, source: "heuristic" };
	}

	return { id: model.id, source: "fallback" };
}

function getCanonicalRecordName(
	record: CanonicalModelRecord | undefined,
	canonicalId: string,
	variant: CanonicalModelVariant,
	referenceData: CanonicalReferenceData,
): string {
	if (record) {
		return record.name;
	}
	return referenceData.references.get(canonicalId)?.name ?? variant.model.name ?? canonicalId;
}

function compareCanonicalRecords(left: CanonicalModelRecord, right: CanonicalModelRecord): number {
	return left.id.localeCompare(right.id);
}

function compareCanonicalVariants(left: CanonicalModelVariant, right: CanonicalModelVariant): number {
	const leftSelector = left.selector;
	const rightSelector = right.selector;
	return leftSelector.localeCompare(rightSelector);
}

export function buildCanonicalModelIndex(
	models: readonly Model<Api>[],
	equivalence?: ModelEquivalenceConfig,
): CanonicalModelIndex {
	const referenceData = createCanonicalReferenceData();
	const compiledEquivalence = compileEquivalenceConfig(equivalence);
	const byId = new Map<string, CanonicalModelRecord>();
	const bySelector = new Map<string, string>();

	let modelCache = __resolutionCache.get(compiledEquivalence);
	if (!modelCache) {
		modelCache = new WeakMap<Model<Api>, ResolvedCanonicalModel>();
		__resolutionCache.set(compiledEquivalence, modelCache);
	}

	for (const model of models) {
		let canonical = modelCache.get(model);
		if (!canonical) {
			canonical = resolveCanonicalIdForModel(model, compiledEquivalence, referenceData);
			modelCache.set(model, canonical);
		}
		const selector = formatCanonicalVariantSelector(model);
		const variant: CanonicalModelVariant = {
			canonicalId: canonical.id,
			selector,
			model,
			source: canonical.source,
		};
		const canonicalKey = normalizeCanonicalIdKey(canonical.id);
		const existing = byId.get(canonicalKey);
		const nextRecord: CanonicalModelRecord = existing ?? {
			id: canonical.id,
			name: getCanonicalRecordName(existing, canonical.id, variant, referenceData),
			variants: [],
		};
		nextRecord.name = getCanonicalRecordName(existing, canonical.id, variant, referenceData);
		nextRecord.variants.push(variant);
		byId.set(canonicalKey, nextRecord);
		bySelector.set(normalizeSelectorKey(selector), canonical.id);
	}

	const records = [...byId.values()].sort(compareCanonicalRecords);
	for (const record of records) {
		record.variants.sort(compareCanonicalVariants);
	}

	return { records, byId, bySelector };
}
