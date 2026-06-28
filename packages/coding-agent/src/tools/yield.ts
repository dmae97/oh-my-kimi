/**
 * Result submission tool for subagent output.
 *
 * Subagents can call this tool incrementally or terminally depending on `type`.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai/types";
import {
	dereferenceJsonSchema,
	isValidJsonSchema,
	type JsonSchemaValidationResult,
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema,
} from "@oh-my-pi/pi-ai/utils/schema";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ToolSession } from ".";
import { buildOutputValidator, formatAllValidationIssues } from "./output-schema-validator";

export interface YieldDetails {
	/** Successful result payload, or omitted when `useLastTurn` requests last-turn extraction. */
	data?: unknown;
	status: "success" | "aborted";
	error?: string;
	/** Optional result section/classification supplied by the yield caller. */
	type?: string | string[];
	/** True when the caller intentionally omitted success data so the executor uses the last assistant turn. */
	useLastTurn?: boolean;
	/**
	 * Set when the yield tool exhausted its in-tool schema-retry budget
	 * (MAX_SCHEMA_RETRIES) and accepted the data anyway. Surfaced so the
	 * executor's post-mortem finalizer can honor the override instead of
	 * re-rejecting the same payload with `schema_violation` — keeping the
	 * subagent's acceptance and the parent's view of the result in lockstep.
	 */
	schemaOverridden?: boolean;
}

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

function looseRecordSchema(description: string): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: true,
		description,
	};
}

function hasUnresolvedRefs(schema: unknown): boolean {
	if (schema == null) return false;
	if (Array.isArray(schema)) {
		for (const item of schema) {
			if (hasUnresolvedRefs(item)) return true;
		}
		return false;
	}
	if (typeof schema !== "object") return false;
	const record = schema as Record<string, unknown>;
	if (typeof record.$ref === "string") return true;
	for (const key in record) {
		if (key === "const" || key === "default" || key === "enum" || key === "examples") continue;
		if (hasUnresolvedRefs(record[key])) return true;
	}
	return false;
}

const yieldTypeSchema: Record<string, unknown> = {
	anyOf: [
		{ type: "string" },
		{
			type: "array",
			minItems: 1,
			items: { type: "string" },
		},
	],
	description: "Optional result type. A non-empty string array is incremental; a string is terminal.",
};

function isYieldType(value: unknown): value is string | string[] {
	return (
		typeof value === "string" ||
		(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"))
	);
}

function parseYieldType(value: unknown): string | string[] | undefined {
	// Strict-mode providers (OpenAI/Codex) make the optional `type` property
	// required+nullable, so an untyped final yield arrives as `type: null`.
	if (value === undefined || value === null) return undefined;
	if (isYieldType(value)) return value;
	throw new Error("type must be a string or non-empty array of strings");
}

function wrapYieldParameters(dataSchema: Record<string, unknown>): Record<string, unknown> {
	const successResultSchema = {
		type: "object",
		additionalProperties: false,
		description: "task succeeded",
		properties: { data: dataSchema },
		required: ["data"],
	};
	const errorResultSchema = {
		type: "object",
		additionalProperties: false,
		properties: {
			error: { type: "string", description: "error message" },
		},
		required: ["error"],
	};
	const lastTurnResultSchema = {
		type: "object",
		additionalProperties: false,
		description: "typed task succeeded; data omitted so the last assistant turn is used",
		properties: {},
		required: [],
	};
	// The "an empty `result` (last-turn) requires a `type`" invariant is enforced
	// in `execute()` at runtime, NOT in this schema: a top-level combinator
	// (`allOf`/`anyOf`/`oneOf`/...) makes OpenAI/Codex Responses reject the whole
	// tool with `invalid_function_parameters`, so the wrapper stays a plain object.
	return {
		type: "object",
		additionalProperties: false,
		description: "submit data or error",
		properties: {
			type: yieldTypeSchema,
			result: {
				anyOf: [successResultSchema, errorResultSchema, lastTurnResultSchema],
			},
		},
		required: ["result"],
	};
}

/**
 * Max consecutive schema-validation failures before the yield tool overrides validation
 * and lets non-conforming data through. The override is a safety net for schemas the
 * JTD→JSON-Schema converter cannot fully express; it should not be reached during normal
 * model retries. Three matches the existing "3 reminders" pattern elsewhere in the agent
 * runtime.
 */
const MAX_SCHEMA_RETRIES = 3;

export class YieldTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = "yield";
	readonly approval = "read" as const;
	readonly label = "Submit Result";
	readonly description =
		"Submit subagent output. Omit `type` for the usual final structured result.\n\n" +
		'Pass `type: ["section"]` to submit an incremental, non-terminal section that accumulates. Pass `type: "result"` to finalize; when `data` is omitted, your last assistant turn becomes the raw final result.\n' +
		'Use `result: { data: <your output> }` for success, or `result: { error: "message" }` for failure. Keep the `result` wrapper.';
	readonly parameters: TSchema;
	strict = true;
	readonly intent = "omit" as const;
	lenientArgValidation = true;

	readonly #validate?: (value: unknown) => JsonSchemaValidationResult;
	#schemaValidationFailures = 0;

	constructor(session: ToolSession) {
		let validate: ((value: unknown) => JsonSchemaValidationResult) | undefined;
		let parameters: TSchema;

		try {
			const {
				validator,
				jsonSchema: normalizedSchema,
				normalized,
				error: schemaError,
			} = buildOutputValidator(session.outputSchema);
			if (validator) {
				validate = value => validator.validate(value);
			}

			const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);
			const schemaDescription = schemaError
				? `Structured JSON output (output schema invalid; accepting unconstrained object): ${schemaError}`
				: `Structured output matching the schema:\n${schemaHint}`;
			let sanitizedSchema: Record<string, unknown> | undefined;
			if (!schemaError && normalizedSchema !== undefined) {
				const strictProbe = tryEnforceStrictSchema(normalizedSchema);
				if (strictProbe.strict) {
					sanitizedSchema = sanitizeSchemaForStrictMode(normalizedSchema);
				} else {
					sanitizedSchema = normalizedSchema;
					this.strict = false;
				}
			} else if (!schemaError && normalized === true) {
				sanitizedSchema = {};
				this.strict = false;
			}

			let dataSchema: Record<string, unknown>;
			if (sanitizedSchema !== undefined) {
				const resolved = dereferenceJsonSchema({
					...sanitizedSchema,
					description: schemaDescription,
				}) as Record<string, unknown>;
				if (hasUnresolvedRefs(resolved)) {
					throw new Error("schema contains unresolved $ref after dereferencing");
				}
				dataSchema = resolved;
			} else {
				this.strict = false;
				dataSchema = looseRecordSchema(
					schemaError ? schemaDescription : "Structured JSON output (no schema specified)",
				);
			}
			parameters = wrapYieldParameters(dataSchema);
			JSON.stringify(parameters);
			if (!isValidJsonSchema(parameters)) throw new Error("yield parameters schema is invalid");
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			parameters = wrapYieldParameters(
				looseRecordSchema(`Structured JSON output (schema processing failed: ${errorMsg})`),
			);
			validate = undefined;
			this.strict = false;
		}

		this.#validate = validate;
		this.parameters = parameters;
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		const raw = params as Record<string, unknown>;
		const rawResult = raw.result;
		if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
			throw new Error("result must be an object containing either data or error");
		}
		const resultRecord = rawResult as Record<string, unknown>;
		const errorMessage = typeof resultRecord.error === "string" ? resultRecord.error : undefined;
		const data = resultRecord.data;
		const yieldType = parseYieldType(raw.type);
		const useLastTurn =
			errorMessage === undefined && data === undefined && yieldType !== undefined && !("error" in resultRecord);
		// Incremental array-typed sections carry partial data (one finding, one
		// field) that cannot satisfy the full output schema; the assembled result
		// is validated as a whole at finalization (executor finalizeSubprocessOutput).
		const isIncremental = Array.isArray(yieldType) && yieldType.length > 0;

		if (errorMessage !== undefined && data !== undefined) {
			throw new Error("result cannot contain both data and error");
		}
		if (errorMessage === undefined && data === undefined && yieldType === undefined) {
			throw new Error(
				'result must contain either `data` or `error`. Use `{result: {data: <your output>}}` for success or `{result: {error: "message"}}` for failure.',
			);
		}

		const status = errorMessage !== undefined ? "aborted" : "success";
		let schemaValidationOverridden = false;
		if (status === "success" && !useLastTurn) {
			if (data === null) {
				throw new Error("data is required when yield indicates success");
			}
			if (this.#validate && !isIncremental) {
				const parsed = this.#validate(data);
				if (!parsed.success) {
					this.#schemaValidationFailures++;
					if (this.#schemaValidationFailures <= MAX_SCHEMA_RETRIES) {
						const remaining = MAX_SCHEMA_RETRIES - this.#schemaValidationFailures;
						const retryHint =
							remaining > 0
								? ` Call yield again with the corrected shape — ${remaining} retry attempt(s) remain before the schema constraint is dropped.`
								: " Call yield again with the corrected shape — this is the final retry before the schema constraint is dropped.";
						throw new Error(
							`Output does not match schema: ${formatAllValidationIssues(parsed.issues)}.${retryHint}`,
						);
					}
					schemaValidationOverridden = true;
				}
			}
		}

		const responseText =
			status === "aborted"
				? `Task aborted: ${errorMessage}`
				: schemaValidationOverridden
					? `Result submitted (schema validation overridden after ${this.#schemaValidationFailures} failed attempt(s)).`
					: "Result submitted.";
		return {
			content: [{ type: "text", text: responseText }],
			details: {
				data,
				status,
				error: errorMessage,
				type: yieldType,
				useLastTurn: useLastTurn || undefined,
				schemaOverridden: schemaValidationOverridden || undefined,
			},
		};
	}
}

// Register subprocess tool handler for extraction + termination.
subprocessToolRegistry.register<YieldDetails>("yield", {
	extractData: event => {
		const details = event.result?.details;
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const status = record.status;
		if (status !== "success" && status !== "aborted") return undefined;
		return {
			data: record.data,
			status,
			error: typeof record.error === "string" ? record.error : undefined,
			type: isYieldType(record.type) ? record.type : undefined,
			useLastTurn: record.useLastTurn === true ? true : undefined,
			schemaOverridden: record.schemaOverridden === true ? true : undefined,
		};
	},
	shouldTerminate: event => {
		if (event.isError) return false;
		const details = event.result?.details;
		if (!details || typeof details !== "object") return true;
		const record = details as Record<string, unknown>;
		return !(
			record.status === "success" &&
			Array.isArray(record.type) &&
			record.type.length > 0 &&
			record.type.every(item => typeof item === "string")
		);
	},
});
