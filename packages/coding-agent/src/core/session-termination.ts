export const SESSION_TERMINATION_SCHEMA_VERSION = 1 as const;
export const MAX_SESSION_TERMINATION_MESSAGE_LENGTH = 512;

export type SessionTerminationKind =
	| "completed"
	| "user_abort"
	| "provider_abort"
	| "provider_auth"
	| "provider_rate_limit"
	| "provider_network"
	| "provider_protocol"
	| "context_overflow"
	| "transcript_invalid"
	| "tool_timeout"
	| "tool_fatal"
	| "compaction"
	| "persistence"
	| "process_signal"
	| "process_crash"
	| "configuration"
	| "internal_error";

export type SessionTerminationPhase =
	| "completed"
	| "control"
	| "preflight"
	| "provider"
	| "tool"
	| "compaction"
	| "persistence"
	| "process"
	| "resume";

export type SessionTerminationSource = "observed" | "inferred_on_resume";
export type SessionSideEffects = "none" | "possible" | "confirmed";
export type SessionProcessSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";

export type ProviderTerminationCauseCode =
	| "abort"
	| "auth"
	| "rate_limit"
	| "network"
	| "protocol"
	| "context_overflow";
export type ToolTerminationCauseCode = "timeout" | "fatal";
export type CompactionTerminationCauseCode = "aborted" | "failed" | "stale";
export type PersistenceTerminationCauseCode =
	| "read_failed"
	| "append_failed"
	| "replace_failed"
	| "fsync_failed"
	| "lock_failed";
export type TranscriptTerminationCauseCode =
	| "missing_result"
	| "duplicate_result"
	| "orphan_result"
	| "duplicate_call_id"
	| "interleaved_non_result"
	| "invalid_jsonl"
	| "invalid_tree"
	| "unsupported_version"
	| "trailing_fragment";
export type SessionTerminationCauseCode =
	| "session.completed"
	| "session.user_abort"
	| `provider.${ProviderTerminationCauseCode}`
	| `tool.${ToolTerminationCauseCode}`
	| `compaction.${CompactionTerminationCauseCode}`
	| `persistence.${PersistenceTerminationCauseCode}`
	| "process.signal"
	| "process.crash"
	| `transcript.${TranscriptTerminationCauseCode}`
	| "configuration.invalid"
	| "internal.unclassified";

export type SessionTerminationCause =
	| { readonly area: "completed" }
	| { readonly area: "user"; readonly code: "abort" }
	| { readonly area: "provider"; readonly code: ProviderTerminationCauseCode }
	| { readonly area: "tool"; readonly code: ToolTerminationCauseCode }
	| { readonly area: "compaction"; readonly code: CompactionTerminationCauseCode }
	| { readonly area: "persistence"; readonly code: PersistenceTerminationCauseCode }
	| { readonly area: "process"; readonly code: "signal"; readonly signal: SessionProcessSignal }
	| { readonly area: "process"; readonly code: "crash" }
	| { readonly area: "transcript"; readonly code: TranscriptTerminationCauseCode }
	| { readonly area: "configuration"; readonly code: "invalid" }
	| { readonly area: "internal"; readonly code: "unclassified" };

export interface ClassifySessionTerminationInput {
	readonly sessionId: string;
	readonly runId: string;
	/** Deterministic caller-provided ISO-8601 timestamp. */
	readonly timestamp: string;
	readonly source: SessionTerminationSource;
	/** Caller-supplied, pre-redacted diagnostic text. */
	readonly message: string;
	readonly cause: SessionTerminationCause;
	readonly sideEffects: SessionSideEffects;
	readonly retryAfterMs?: number;
	readonly provider?: string;
	readonly model?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
}

export interface SessionTermination {
	readonly schemaVersion: typeof SESSION_TERMINATION_SCHEMA_VERSION;
	readonly sessionId: string;
	readonly runId: string;
	readonly kind: SessionTerminationKind;
	readonly phase: SessionTerminationPhase;
	readonly source: SessionTerminationSource;
	readonly message: string;
	readonly causeCode: SessionTerminationCauseCode;
	/** Stable operator guidance suitable for print, JSON, RPC, and TUI surfaces. */
	readonly nextAction: string;
	readonly retryable: boolean;
	readonly safeToAutoRetry: boolean;
	readonly sideEffects: SessionSideEffects;
	readonly timestamp: string;
	readonly retryAfterMs?: number;
	readonly provider?: string;
	readonly model?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly processSignal?: SessionProcessSignal;
	readonly transcriptIssue?: TranscriptTerminationCauseCode;
}

export class SessionTerminationError extends Error {
	readonly termination: SessionTermination;

	constructor(message: string, termination: SessionTermination) {
		super(message);
		this.name = "SessionTerminationError";
		this.termination = termination;
	}
}

interface Classification {
	readonly kind: SessionTerminationKind;
	readonly phase: SessionTerminationPhase;
	readonly causeCode: SessionTerminationCauseCode;
	readonly retryable: boolean;
	readonly processSignal?: SessionProcessSignal;
	readonly transcriptIssue?: TranscriptTerminationCauseCode;
}

const CREDENTIAL_SHAPES = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
	/\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/,
	/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/i,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	/(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:authorization|api[-_ ]?key|access[-_ ]?token|token|password|secret(?:[-_ ]?key)?|private[-_ ]?key|cookie)["']?\s*[:=]/i,
] as const;

const TOP_LEVEL_KEYS = new Set([
	"sessionId",
	"runId",
	"timestamp",
	"source",
	"message",
	"cause",
	"sideEffects",
	"retryAfterMs",
	"provider",
	"model",
	"toolCallId",
	"toolName",
]);
const PROVIDER_CAUSE_CODES = new Set<ProviderTerminationCauseCode>([
	"abort",
	"auth",
	"rate_limit",
	"network",
	"protocol",
	"context_overflow",
]);
const TOOL_CAUSE_CODES = new Set<ToolTerminationCauseCode>(["timeout", "fatal"]);
const COMPACTION_CAUSE_CODES = new Set<CompactionTerminationCauseCode>(["aborted", "failed", "stale"]);
const PERSISTENCE_CAUSE_CODES = new Set<PersistenceTerminationCauseCode>([
	"read_failed",
	"append_failed",
	"replace_failed",
	"fsync_failed",
	"lock_failed",
]);
const TRANSCRIPT_CAUSE_CODES = new Set<TranscriptTerminationCauseCode>([
	"missing_result",
	"duplicate_result",
	"orphan_result",
	"duplicate_call_id",
	"interleaved_non_result",
	"invalid_jsonl",
	"invalid_tree",
	"unsupported_version",
	"trailing_fragment",
]);
const PROCESS_SIGNALS = new Set<SessionProcessSignal>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function assertCause(cause: unknown): asserts cause is SessionTerminationCause {
	if (!isRecord(cause) || typeof cause.area !== "string") {
		throw new TypeError("cause must be a bounded structured termination cause");
	}
	const code = cause.code;
	let valid = false;
	switch (cause.area) {
		case "completed":
			valid = hasOnlyKeys(cause, ["area"]);
			break;
		case "user":
			valid = code === "abort" && hasOnlyKeys(cause, ["area", "code"]);
			break;
		case "provider":
			valid =
				typeof code === "string" &&
				PROVIDER_CAUSE_CODES.has(code as ProviderTerminationCauseCode) &&
				hasOnlyKeys(cause, ["area", "code"]);
			break;
		case "tool":
			valid =
				typeof code === "string" &&
				TOOL_CAUSE_CODES.has(code as ToolTerminationCauseCode) &&
				hasOnlyKeys(cause, ["area", "code"]);
			break;
		case "compaction":
			valid =
				typeof code === "string" &&
				COMPACTION_CAUSE_CODES.has(code as CompactionTerminationCauseCode) &&
				hasOnlyKeys(cause, ["area", "code"]);
			break;
		case "persistence":
			valid =
				typeof code === "string" &&
				PERSISTENCE_CAUSE_CODES.has(code as PersistenceTerminationCauseCode) &&
				hasOnlyKeys(cause, ["area", "code"]);
			break;
		case "process":
			valid =
				(code === "crash" && hasOnlyKeys(cause, ["area", "code"])) ||
				(code === "signal" &&
					typeof cause.signal === "string" &&
					PROCESS_SIGNALS.has(cause.signal as SessionProcessSignal) &&
					hasOnlyKeys(cause, ["area", "code", "signal"]));
			break;
		case "transcript":
			valid =
				typeof code === "string" &&
				TRANSCRIPT_CAUSE_CODES.has(code as TranscriptTerminationCauseCode) &&
				hasOnlyKeys(cause, ["area", "code"]);
			break;
		case "configuration":
			valid = code === "invalid" && hasOnlyKeys(cause, ["area", "code"]);
			break;
		case "internal":
			valid = code === "unclassified" && hasOnlyKeys(cause, ["area", "code"]);
			break;
	}
	if (!valid) throw new TypeError("cause must be a bounded structured termination cause");
}

function assertClassifierInput(input: unknown): asserts input is ClassifySessionTerminationInput {
	if (!isRecord(input) || Object.keys(input).some((key) => !TOP_LEVEL_KEYS.has(key))) {
		throw new TypeError("input must contain only bounded structured termination fields");
	}
	if (
		typeof input.sessionId !== "string" ||
		typeof input.runId !== "string" ||
		typeof input.timestamp !== "string" ||
		typeof input.message !== "string" ||
		(input.source !== "observed" && input.source !== "inferred_on_resume") ||
		(input.sideEffects !== "none" && input.sideEffects !== "possible" && input.sideEffects !== "confirmed") ||
		(input.retryAfterMs !== undefined && typeof input.retryAfterMs !== "number") ||
		(input.provider !== undefined && typeof input.provider !== "string") ||
		(input.model !== undefined && typeof input.model !== "string") ||
		(input.toolCallId !== undefined && typeof input.toolCallId !== "string") ||
		(input.toolName !== undefined && typeof input.toolName !== "string")
	) {
		throw new TypeError("input must contain only bounded structured termination fields");
	}
	assertCause(input.cause);
}

function assertIdentifier(value: string, name: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`${name} must be non-empty bounded text without C0 or DEL control characters`);
	}
}

/** Validate text at the termination trust boundary without attempting redaction. */
export function assertPreRedactedTerminationMessage(message: string): void {
	if (message.length === 0 || message.length > MAX_SESSION_TERMINATION_MESSAGE_LENGTH) {
		throw new TypeError(
			`message must contain 1-${MAX_SESSION_TERMINATION_MESSAGE_LENGTH} characters of pre-redacted text`,
		);
	}
	if (message.includes("\0")) {
		throw new TypeError("message must not contain NUL");
	}
	if (CREDENTIAL_SHAPES.some((pattern) => pattern.test(message))) {
		throw new TypeError("message contains a credential-shaped literal; redact it before classification");
	}
}

function assertTimestamp(timestamp: string): void {
	const parsed = new Date(timestamp);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
		throw new TypeError("timestamp must be a canonical ISO-8601 UTC instant");
	}
}

function classifyProvider(code: ProviderTerminationCauseCode): Classification {
	switch (code) {
		case "abort":
			return {
				kind: "provider_abort",
				phase: "provider",
				causeCode: "provider.abort",
				retryable: true,
			};
		case "auth":
			return {
				kind: "provider_auth",
				phase: "provider",
				causeCode: "provider.auth",
				retryable: false,
			};
		case "rate_limit":
			return {
				kind: "provider_rate_limit",
				phase: "provider",
				causeCode: "provider.rate_limit",
				retryable: true,
			};
		case "network":
			return {
				kind: "provider_network",
				phase: "provider",
				causeCode: "provider.network",
				retryable: true,
			};
		case "protocol":
			return {
				kind: "provider_protocol",
				phase: "provider",
				causeCode: "provider.protocol",
				retryable: false,
			};
		case "context_overflow":
			return {
				kind: "context_overflow",
				phase: "provider",
				causeCode: "provider.context_overflow",
				retryable: true,
			};
	}
}

function classifyCause(cause: SessionTerminationCause, source: SessionTerminationSource): Classification {
	switch (cause.area) {
		case "completed":
			return {
				kind: "completed",
				phase: "completed",
				causeCode: "session.completed",
				retryable: false,
			};
		case "user":
			return {
				kind: "user_abort",
				phase: "control",
				causeCode: "session.user_abort",
				retryable: false,
			};
		case "provider":
			return classifyProvider(cause.code);
		case "tool":
			return cause.code === "timeout"
				? { kind: "tool_timeout", phase: "tool", causeCode: "tool.timeout", retryable: true }
				: { kind: "tool_fatal", phase: "tool", causeCode: "tool.fatal", retryable: false };
		case "compaction":
			return {
				kind: "compaction",
				phase: "compaction",
				causeCode: `compaction.${cause.code}`,
				retryable: true,
			};
		case "persistence":
			return {
				kind: "persistence",
				phase: "persistence",
				causeCode: `persistence.${cause.code}`,
				retryable: true,
			};
		case "process":
			if (cause.code === "signal") {
				return {
					kind: "process_signal",
					phase: "process",
					causeCode: "process.signal",
					retryable: false,
					processSignal: cause.signal,
				};
			}
			return {
				kind: "process_crash",
				phase: "resume",
				causeCode: "process.crash",
				retryable: true,
			};
		case "transcript":
			return {
				kind: "transcript_invalid",
				phase: source === "inferred_on_resume" ? "resume" : "preflight",
				causeCode: `transcript.${cause.code}`,
				retryable: false,
				transcriptIssue: cause.code,
			};
		case "configuration":
			return {
				kind: "configuration",
				phase: "preflight",
				causeCode: "configuration.invalid",
				retryable: false,
			};
		case "internal":
			return {
				kind: "internal_error",
				phase: "preflight",
				causeCode: "internal.unclassified",
				retryable: false,
			};
	}
}

function isSafeToAutoRetry(classification: Classification, input: ClassifySessionTerminationInput): boolean {
	return (
		classification.retryable &&
		input.source === "observed" &&
		input.sideEffects === "none" &&
		(classification.kind === "provider_rate_limit" || classification.kind === "provider_network")
	);
}

function nextActionFor(classification: Classification, input: ClassifySessionTerminationInput): string {
	switch (classification.kind) {
		case "completed":
			return "No recovery action is required; continue with the next prompt.";
		case "user_abort":
			return "Review possible partial side effects, then retry only if intended.";
		case "provider_abort":
			return "Confirm provider availability, then retry the request.";
		case "provider_auth":
			return `Run /login${input.provider ? ` ${input.provider}` : ""} or configure valid credentials, then retry.`;
		case "provider_rate_limit":
			return "Wait for the provider retry window or choose another model, then retry.";
		case "provider_network":
			return "Check network and provider connectivity, then retry.";
		case "provider_protocol":
			return "Check provider compatibility and response diagnostics before retrying.";
		case "context_overflow":
			return "Compact or reduce context, or switch to a larger-context model.";
		case "tool_timeout":
			return "Inspect possible tool side effects and increase the tool timeout only if safe.";
		case "tool_fatal":
			return "Inspect the failed tool result and repair its configuration before retrying.";
		case "compaction":
			return "Retry compaction after resolving the reported barrier or stale transaction.";
		case "persistence":
			return `Run omk session doctor --session ${input.sessionId} before resuming.`;
		case "process_signal":
			return "Review possible partial side effects before resuming the session.";
		case "process_crash":
			return `Run omk session doctor --session ${input.sessionId} and review partial side effects.`;
		case "transcript_invalid":
			return `Run omk session doctor --session ${input.sessionId}; do not resume until integrity passes.`;
		case "configuration":
			return "Correct the provider, model, tool, or session configuration and retry.";
		case "internal_error":
			return `Inspect run ${input.runId} diagnostics and the run journal before retrying.`;
	}
}

/** Concise actionable rendering shared by non-JSON and TUI surfaces. */
export function formatSessionTermination(termination: SessionTermination): string {
	const route =
		termination.provider || termination.model
			? `${termination.provider ?? "unknown"}/${termination.model ?? "unknown"}`
			: "n/a";
	return [
		`kind=${termination.kind}`,
		`provider/model=${route}`,
		`retryable=${termination.retryable}`,
		`cause=${termination.causeCode}`,
		`message=${termination.message}`,
		`run=${termination.runId}`,
		`next=${termination.nextAction}`,
	].join(" ");
}

/**
 * Classify a bounded, structured termination cause. This intentionally accepts
 * no raw Error value, stack, provider body, or arbitrary cause code.
 */
export function classifySessionTermination(input: ClassifySessionTerminationInput): SessionTermination {
	assertClassifierInput(input);
	assertIdentifier(input.sessionId, "sessionId", 128);
	assertIdentifier(input.runId, "runId", 128);
	assertTimestamp(input.timestamp);
	assertPreRedactedTerminationMessage(input.message);
	if (input.provider !== undefined) assertIdentifier(input.provider, "provider", 128);
	if (input.model !== undefined) assertIdentifier(input.model, "model", 256);
	if (input.toolCallId !== undefined) assertIdentifier(input.toolCallId, "toolCallId", 512);
	if (input.toolName !== undefined) assertIdentifier(input.toolName, "toolName", 128);
	if (input.retryAfterMs !== undefined && (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0)) {
		throw new TypeError("retryAfterMs must be a non-negative safe integer");
	}
	if (input.cause.area === "process" && input.cause.code === "crash" && input.source !== "inferred_on_resume") {
		throw new TypeError("process crashes may only be classified as inferred_on_resume");
	}
	if (input.cause.area === "process" && input.cause.code === "signal" && input.source !== "observed") {
		throw new TypeError("process signals must be observed");
	}

	const classification = classifyCause(input.cause, input.source);
	return Object.freeze({
		schemaVersion: SESSION_TERMINATION_SCHEMA_VERSION,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: classification.kind,
		phase: classification.phase,
		source: input.source,
		message: input.message,
		causeCode: classification.causeCode,
		nextAction: nextActionFor(classification, input),
		retryable: classification.retryable,
		safeToAutoRetry: isSafeToAutoRetry(classification, input),
		sideEffects: input.sideEffects,
		timestamp: input.timestamp,
		...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
		...(input.provider === undefined ? {} : { provider: input.provider }),
		...(input.model === undefined ? {} : { model: input.model }),
		...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
		...(input.toolName === undefined ? {} : { toolName: input.toolName }),
		...(classification.processSignal === undefined ? {} : { processSignal: classification.processSignal }),
		...(classification.transcriptIssue === undefined ? {} : { transcriptIssue: classification.transcriptIssue }),
	});
}
