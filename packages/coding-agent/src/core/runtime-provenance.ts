/**
 * Runtime provenance projection for OMK observability artifacts.
 *
 * Records the requested, selected, and provider-reported models plus the
 * requested and effective thinking levels for one agent turn. This answers the
 * question "which model actually answered?" without trusting a single source:
 * a provider failover or subagent fallback shows up as selected vs response
 * divergence instead of silently rewriting history.
 *
 * Posture-neutral by design: this module only projects facts into metrics and
 * report artifacts. It never gates, routes, or alters any runtime behavior,
 * and it carries no prompt text, tool arguments, output, or credentials.
 *
 * Two boundaries, two policies:
 * - `buildRuntimeProvenance` (trusted caller): sanitizes each field and maps
 *   anything unusable to `null`. Never throws.
 * - `parseRuntimeProvenance` (untrusted persisted data): rejects the whole
 *   record on any invalid or credential-shaped field. Never throws; returns
 *   `null` so a tampered line can never upgrade trust.
 */

export const RUNTIME_PROVENANCE_SCHEMA_VERSION = "omk-runtime-provenance-1" as const;

export interface RuntimeProvenance {
	readonly schemaVersion: typeof RUNTIME_PROVENANCE_SCHEMA_VERSION;
	/** `provider/model` the turn was requested with, captured at turn start. */
	readonly requestedModel: string | null;
	/** `provider/model` selected for the turn, captured at turn end. */
	readonly selectedModel: string | null;
	/** Concrete provider-reported model, else `provider/model` of the assistant message. */
	readonly responseModel: string | null;
	/** Requested thinking: `"auto"` in auto mode, else the level at turn start. */
	readonly requestedThinking: string | null;
	/** Effective thinking level after resolution, captured at turn end. */
	readonly effectiveThinking: string | null;
	readonly source: "session" | "assistant-message" | "subagent-child";
	readonly observedAt: string;
}

export interface RuntimeProvenanceInput {
	readonly requestedModel?: string | null;
	readonly selectedModel?: string | null;
	readonly responseModel?: string | null;
	readonly requestedThinking?: string | null;
	readonly effectiveThinking?: string | null;
	readonly source?: RuntimeProvenance["source"];
	readonly observedAt?: string;
}

const KEYS = [
	"schemaVersion",
	"requestedModel",
	"selectedModel",
	"responseModel",
	"requestedThinking",
	"effectiveThinking",
	"source",
	"observedAt",
] as const;

const ALLOWED_KEYS: ReadonlySet<string> = new Set(KEYS);

/** Model refs and thinking tokens: bounded length, no control chars or whitespace. */
const SAFE_FIELD = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,127}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Credential shapes from the mask-at-ingest policy; a provider echoing one as a
// "model name" is dropped, never persisted.
const CREDENTIAL_SHAPE = /sk-ant-|AKIA[0-9A-Z]{8,}|ghp_[0-9A-Za-z]{10,}|xox[baprs]-|\bBearer\s/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeField(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || !SAFE_FIELD.test(trimmed) || CREDENTIAL_SHAPE.test(trimmed)) return null;
	return trimmed;
}

function sanitizeSource(value: unknown): RuntimeProvenance["source"] {
	return value === "session" || value === "assistant-message" || value === "subagent-child" ? value : "session";
}

function sanitizeTimestamp(value: unknown): string {
	return typeof value === "string" && ISO_TIMESTAMP.test(value) ? value : new Date().toISOString();
}

/** Build a provenance record from trusted caller-supplied facts. Never throws. */
export function buildRuntimeProvenance(input: RuntimeProvenanceInput = {}): RuntimeProvenance {
	return Object.freeze({
		schemaVersion: RUNTIME_PROVENANCE_SCHEMA_VERSION,
		requestedModel: sanitizeField(input.requestedModel),
		selectedModel: sanitizeField(input.selectedModel),
		responseModel: sanitizeField(input.responseModel),
		requestedThinking: sanitizeField(input.requestedThinking),
		effectiveThinking: sanitizeField(input.effectiveThinking),
		source: sanitizeSource(input.source),
		observedAt: sanitizeTimestamp(input.observedAt),
	});
}

/**
 * Fail-closed parse of untrusted persisted data. Returns `null` (never throws)
 * when any field is invalid, credential-shaped, oversized, or when the key set
 * or schema version is wrong. Missing fields become `null` values.
 */
export function parseRuntimeProvenance(value: unknown): RuntimeProvenance | null {
	if (!isRecord(value)) return null;
	for (const key of Object.keys(value)) {
		if (!ALLOWED_KEYS.has(key)) return null;
	}
	if (value.schemaVersion !== RUNTIME_PROVENANCE_SCHEMA_VERSION) return null;
	if (value.source !== "session" && value.source !== "assistant-message" && value.source !== "subagent-child") {
		return null;
	}
	if (value.observedAt !== undefined && !ISO_TIMESTAMP.test(String(value.observedAt))) return null;
	try {
		return Object.freeze({
			schemaVersion: RUNTIME_PROVENANCE_SCHEMA_VERSION,
			requestedModel: parseRequiredField(value.requestedModel),
			selectedModel: parseRequiredField(value.selectedModel),
			responseModel: parseRequiredField(value.responseModel),
			requestedThinking: parseRequiredField(value.requestedThinking),
			effectiveThinking: parseRequiredField(value.effectiveThinking),
			source: value.source,
			observedAt: value.observedAt === undefined ? new Date().toISOString() : String(value.observedAt),
		});
	} catch {
		return null;
	}
}

/** Missing fields parse as `null`; anything present but unusable throws (record fails closed). */
function parseRequiredField(field: unknown): string | null {
	if (field === undefined || field === null) return null;
	if (typeof field !== "string") throw new TypeError("runtime provenance field is not a string");
	const sanitized = sanitizeField(field);
	if (sanitized === null) throw new TypeError("runtime provenance field is invalid or credential-shaped");
	return sanitized;
}
