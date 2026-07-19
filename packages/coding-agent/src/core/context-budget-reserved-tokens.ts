/**
 * Pure, deterministic reserved-token budget arithmetic.
 *
 * This module is host-API-free: it relies only on plain ECMAScript value
 * semantics. Invalid input and unsafe arithmetic that would lose integer
 * precision both fail closed by throwing {@link ReservedTokenBudgetError}.
 *
 * The budget is one exact subtraction:
 *
 *   effectiveBudget = modelContextWindow
 *                       - systemPromptTokens
 *                       - reservedOutputTokens
 *                       - reservedToolResultTokens
 *                       - safetyMarginTokens
 *                       - imageReserveTokens
 *
 * The four reserve terms (output, tool result, safety margin, image reserve)
 * are summed into `totalReserved` first; the final budget is the single
 * subtraction `modelContextWindow - (systemPromptTokens + totalReserved)`.
 */

/**
 * The complete, frozen set of supported tool-result classes. The literal union
 * {@link ToolResultClass} is derived from this tuple. Frozen at runtime so the
 * supported set cannot be mutated after import; the `as const` tuple type is
 * preserved (freeze returns `Readonly` of the same tuple).
 */
export const TOOL_RESULT_CLASSES = Object.freeze(["text", "image", "large-output"] as const);
export type ToolResultClass = (typeof TOOL_RESULT_CLASSES)[number];

/**
 * Fixed upper bound on the number of per-class requests accepted by
 * {@link estimateToolResultReserve}. Request arrays longer than this cap are
 * rejected before any iteration or arithmetic, keeping the estimator's loop
 * bounded and predictable. A deliberately conservative constant.
 */
export const MAX_TOOL_RESULT_RESERVE_REQUESTS = 64;

const TOOL_RESULT_CLASS_SET: ReadonlySet<string> = new Set(TOOL_RESULT_CLASSES);

const REQUEST_KEYS = ["class", "count", "tokensPerResult"] as const;

const BUDGET_INPUT_KEYS = [
	"modelContextWindow",
	"systemPromptTokens",
	"reservedOutputTokens",
	"reservedToolResultTokens",
	"safetyMarginTokens",
	"imageReserveTokens",
] as const;

/**
 * A bounded per-class reserve request for tool results.
 *
 * `count` results of `class`, each reserving `tokensPerResult` tokens.
 */
export interface ToolResultReserveRequest {
	readonly class: ToolResultClass;
	readonly count: number;
	readonly tokensPerResult: number;
}

/** Exact inputs to {@link computeReservedTokenBudget}. All terms are nonnegative safe integers. */
export interface ReservedTokenBudgetInput {
	readonly modelContextWindow: number;
	readonly systemPromptTokens: number;
	/** A single output-reserve term. No implicit ratio or default is applied. */
	readonly reservedOutputTokens: number;
	/**
	 * Single term for reserved tool-result tokens. Pass
	 * {@link estimateToolResultReserve} here. Empty/zero is allowed.
	 */
	readonly reservedToolResultTokens: number;
	readonly safetyMarginTokens: number;
	/**
	 * Reserve for image content. Distinct from the tool-result `image` class:
	 * account image tokens in exactly one of these two places to avoid
	 * double-accounting.
	 */
	readonly imageReserveTokens: number;
}

/** A deeply frozen copy of the terms used in the budget computation. */
export interface ReservedTokenBudgetTerms {
	readonly modelContextWindow: number;
	readonly systemPromptTokens: number;
	readonly reservedOutputTokens: number;
	readonly reservedToolResultTokens: number;
	readonly safetyMarginTokens: number;
	readonly imageReserveTokens: number;
}

export interface ReservedTokenBudgetResult {
	readonly terms: ReservedTokenBudgetTerms;
	/** reservedOutput + reservedToolResult + safetyMargin + imageReserve (excludes systemPrompt and the window). */
	readonly totalReserved: number;
	/**
	 * `modelContextWindow - systemPromptTokens - totalReserved`, clamped at 0.
	 *
	 * Exact-zero semantics: when the raw subtraction is exactly 0 the budget is
	 * 0 and {@link overflow} is `false` — the window is exactly filled, not
	 * exceeded. {@link overflow} is `true` only when the raw subtraction is
	 * strictly negative (see {@link overflow}).
	 */
	readonly effectiveBudget: number;
	/**
	 * `true` only when the raw subtraction
	 * `modelContextWindow - systemPromptTokens - totalReserved` is strictly
	 * negative (reserves exceed the window). A raw result of exactly 0 is NOT
	 * overflow: {@link effectiveBudget} is 0 but this flag stays `false`.
	 */
	readonly overflow: boolean;
}

export class ReservedTokenBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReservedTokenBudgetError";
	}
}

/**
 * Validate that `value` is a plain data record with exactly the expected keys.
 *
 * A plain data record is a non-null, non-array object whose prototype is
 * `Object.prototype` or `null` (null-prototype data objects are accepted) and
 * whose own properties are all data properties (no getters/setters). This
 * rejects arrays, class instances / other non-standard prototypes, accessor
 * properties, and records with missing or unexpected keys — all via
 * {@link ReservedTokenBudgetError} so callers fail closed consistently.
 */
function assertPlainDataRecord(value: unknown, label: string, expected: readonly string[]): void {
	if (typeof value !== "object" || value === null) {
		throw new ReservedTokenBudgetError(`${label} must be a non-null object`);
	}
	if (Array.isArray(value)) {
		throw new ReservedTokenBudgetError(`${label} must be a plain object, not an array`);
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) {
		throw new ReservedTokenBudgetError(`${label} must be a plain data record (unexpected prototype)`);
	}
	for (const key of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor !== undefined && (typeof descriptor.get === "function" || typeof descriptor.set === "function")) {
			throw new ReservedTokenBudgetError(`${label} must not have accessor property "${key}"`);
		}
	}
	const expectedSet = new Set(expected);
	const actual = Object.keys(value);
	for (const key of actual) {
		if (!expectedSet.has(key)) {
			throw new ReservedTokenBudgetError(`${label} has unexpected key "${key}"`);
		}
	}
	if (actual.length !== expected.length) {
		const missing = expected.filter((key) => !(key in value));
		throw new ReservedTokenBudgetError(`${label} is missing required key(s): ${missing.join(", ")}`);
	}
}

function assertNonNegativeSafeInteger(value: unknown, label: string): void {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ReservedTokenBudgetError(`${label} must be a finite number (got ${String(value)})`);
	}
	if (!Number.isSafeInteger(value)) {
		throw new ReservedTokenBudgetError(`${label} must be a safe integer (got ${value})`);
	}
	if (value < 0) {
		throw new ReservedTokenBudgetError(`${label} must be nonnegative (got ${value})`);
	}
}

/** Add two nonnegative safe integers, failing closed before precision loss. */
function safeAdd(a: number, b: number, label: string): number {
	if (b > Number.MAX_SAFE_INTEGER - a) {
		throw new ReservedTokenBudgetError(`arithmetic overflow while ${label}: ${a} + ${b}`);
	}
	return a + b;
}

/** Multiply two nonnegative safe integers, failing closed if the product is unsafe. */
function safeMultiply(a: number, b: number, label: string): number {
	if (a === 0 || b === 0) {
		return 0;
	}
	const product = a * b;
	if (!Number.isSafeInteger(product) || product / a !== b || product / b !== a) {
		throw new ReservedTokenBudgetError(`arithmetic overflow while ${label}: ${a} * ${b}`);
	}
	return product;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

/**
 * Estimate reserved tool-result tokens from bounded per-class requests using
 * safe-integer arithmetic. Returns the exact total. Empty input yields 0.
 * Throws {@link ReservedTokenBudgetError} on any invalid/overflowing input.
 */
export function estimateToolResultReserve(requests: readonly ToolResultReserveRequest[]): number {
	if (!Array.isArray(requests)) {
		throw new ReservedTokenBudgetError("requests must be an array");
	}
	if (requests.length > MAX_TOOL_RESULT_RESERVE_REQUESTS) {
		throw new ReservedTokenBudgetError(
			`requests length ${requests.length} exceeds maximum ${MAX_TOOL_RESULT_RESERVE_REQUESTS}`,
		);
	}
	let total = 0;
	for (let i = 0; i < requests.length; i += 1) {
		const request = requests[i];
		const itemLabel = `requests[${i}]`;
		assertPlainDataRecord(request, itemLabel, REQUEST_KEYS);
		if (!TOOL_RESULT_CLASS_SET.has(request.class)) {
			throw new ReservedTokenBudgetError(
				`${itemLabel}.class must be one of ${TOOL_RESULT_CLASSES.join(", ")} (got ${String(request.class)})`,
			);
		}
		assertNonNegativeSafeInteger(request.count, `${itemLabel}.count`);
		assertNonNegativeSafeInteger(request.tokensPerResult, `${itemLabel}.tokensPerResult`);
		const perClassTotal = safeMultiply(request.count, request.tokensPerResult, `${itemLabel} count*tokensPerResult`);
		total = safeAdd(total, perClassTotal, `summing tool result reserves at ${itemLabel}`);
	}
	return total;
}

/**
 * Compute the effective reserved-token budget via a single exact subtraction.
 * All inputs must be nonnegative safe integers. The returned object (and its
 * nested `terms`) is deeply frozen and independent of the caller's input.
 */
export function computeReservedTokenBudget(input: ReservedTokenBudgetInput): ReservedTokenBudgetResult {
	assertPlainDataRecord(input, "input", BUDGET_INPUT_KEYS);
	assertNonNegativeSafeInteger(input.modelContextWindow, "modelContextWindow");
	assertNonNegativeSafeInteger(input.systemPromptTokens, "systemPromptTokens");
	assertNonNegativeSafeInteger(input.reservedOutputTokens, "reservedOutputTokens");
	assertNonNegativeSafeInteger(input.reservedToolResultTokens, "reservedToolResultTokens");
	assertNonNegativeSafeInteger(input.safetyMarginTokens, "safetyMarginTokens");
	assertNonNegativeSafeInteger(input.imageReserveTokens, "imageReserveTokens");

	const totalReserved = safeAdd(
		safeAdd(
			safeAdd(input.reservedOutputTokens, input.reservedToolResultTokens, "output+toolResult"),
			input.safetyMarginTokens,
			"+safetyMargin",
		),
		input.imageReserveTokens,
		"+imageReserve",
	);
	const consumed = safeAdd(input.systemPromptTokens, totalReserved, "systemPrompt+totalReserved");
	const rawEffective = input.modelContextWindow - consumed;
	const overflow = rawEffective < 0;
	const effectiveBudget = overflow ? 0 : rawEffective;

	const terms: ReservedTokenBudgetTerms = {
		modelContextWindow: input.modelContextWindow,
		systemPromptTokens: input.systemPromptTokens,
		reservedOutputTokens: input.reservedOutputTokens,
		reservedToolResultTokens: input.reservedToolResultTokens,
		safetyMarginTokens: input.safetyMarginTokens,
		imageReserveTokens: input.imageReserveTokens,
	};
	return deepFreeze({
		terms,
		totalReserved,
		effectiveBudget,
		overflow,
	});
}
