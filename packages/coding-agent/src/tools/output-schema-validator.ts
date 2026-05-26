/**
 * Shared output-schema validation for subagent yield + executor finalization.
 *
 * Both the in-process `yield` tool (subagent side) and the executor's post-mortem
 * finalize path (parent side) need to validate yield payloads against the agent's
 * declared output schema. This module is the single source of truth for that
 * pipeline — keeping the two callsites in lockstep so a schema accepted in-tool
 * cannot be rejected post-mortem (or vice versa).
 */
import {
	isValidJsonSchema,
	type JsonSchemaValidationIssue,
	type JsonSchemaValidationResult,
	validateJsonSchemaValue,
} from "@oh-my-pi/pi-ai/utils/schema";
import { jtdToJsonSchema, normalizeSchema } from "./jtd-to-json-schema";

/** A validator bound to a specific output schema. */
export interface OutputValidator {
	/** Run JSON Schema validation; returns the raw `success`/`issues` shape so callers may inspect every failure. */
	validate(value: unknown): JsonSchemaValidationResult;
	/** Top-level required property names. Empty if the schema has no `required` array at root. */
	readonly requiredFields: readonly string[];
}

export interface BuildOutputValidatorResult {
	/** Present when the schema produced a usable validator (i.e. constraining schemas). Absent for missing/unconstrained schemas. */
	validator?: OutputValidator;
	/** Raw JSON Schema produced by `jtdToJsonSchema`. Available alongside the validator so callers can derive related artifacts (strict-mode probe, dereference, hint text). */
	jsonSchema?: Record<string, unknown>;
	/**
	 * Normalized schema (post-`normalizeSchema`). Surfaced so callers can distinguish
	 * "no schema provided" (`undefined`) from "intentionally unconstrained" (`true`)
	 * when both produce no validator.
	 */
	normalized?: unknown;
	/** Set when the schema cannot be used. Callers should treat this as a "no validation" case (loose acceptance) and surface the message in diagnostics. */
	error?: string;
}

/**
 * Build the canonical validator for a JTD-or-JSON-Schema output declaration.
 *
 * Returns:
 * - `{ validator, jsonSchema, normalized }` for constraining schemas — both callers use this path.
 * - `{ normalized: true }` for an intentionally unconstrained schema (the JSON Schema literal `true`).
 *   No validator, but distinguishable from "no schema provided".
 * - `{}` for an absent schema (`undefined`).
 * - `{ error, normalized? }` when the schema cannot be honored (invalid syntax, `false`, malformed JTD).
 */
export function buildOutputValidator(schema: unknown): BuildOutputValidatorResult {
	const { normalized, error: normalizeError } = normalizeSchema(schema);
	if (normalizeError) return { error: normalizeError, normalized };
	if (normalized === undefined) return {};
	if (normalized === false) return { error: "boolean false schema rejects all outputs", normalized };
	if (normalized === true) return { normalized };

	const jsonSchema = jtdToJsonSchema(normalized);
	if (jsonSchema === undefined) return { normalized };
	if (jsonSchema === false) return { error: "boolean false schema rejects all outputs", normalized };
	if (jsonSchema === true) return { normalized };
	if (typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
		return { error: "invalid JSON schema", normalized };
	}
	if (!isValidJsonSchema(jsonSchema)) return { error: "invalid JSON schema", normalized };

	const jsonSchemaRecord = jsonSchema as Record<string, unknown>;
	const required = extractRequiredFields(jsonSchemaRecord);
	return {
		normalized,
		jsonSchema: jsonSchemaRecord,
		validator: {
			requiredFields: required,
			validate: value => validateJsonSchemaValue(jsonSchemaRecord, value),
		},
	};
}

/** Produce the executor's headline+missing-required summary from a failed validation. */
export function summarizeValidationFailure(
	result: JsonSchemaValidationResult,
	value: unknown,
	requiredFields: readonly string[],
): { message: string; missingRequired: string[] } {
	if (result.success) return { message: "", missingRequired: [] };
	const missing = computeMissingRequired(requiredFields, value);
	const message = formatValidationIssueHeadline(result.issues[0]) ?? "schema validation failed";
	return { message, missingRequired: missing };
}

export function extractRequiredFields(jsonSchema: unknown): string[] {
	if (!jsonSchema || typeof jsonSchema !== "object") return [];
	const required = (jsonSchema as { required?: unknown }).required;
	return Array.isArray(required) ? required.filter((k): k is string => typeof k === "string") : [];
}

export function computeMissingRequired(required: readonly string[], value: unknown): string[] {
	if (required.length === 0) return [];
	if (value === null || value === undefined) return [...required];
	if (typeof value !== "object" || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	return required.filter(key => !(key in record) || record[key] === undefined);
}

/**
 * Format a single validation issue as `path.with.dots: message`.
 *
 * Used by the executor's post-mortem `schema_violation` headline — one line, dot-separated path,
 * since the executor's error format already lists missing-required fields separately.
 */
export function formatValidationIssueHeadline(issue: JsonSchemaValidationIssue | undefined): string | undefined {
	if (!issue) return undefined;
	const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
	return `${path}: ${issue.message}`;
}

/**
 * Format every validation issue as `path/with/slashes: message; ...`.
 *
 * Used by the yield tool's model-facing retry feedback — the model gets every problem at once so it
 * can fix the entire output in one retry instead of iterating issue-by-issue. The slash separator
 * mirrors JSON Pointer convention and disambiguates against fields whose names contain dots.
 */
export function formatAllValidationIssues(issues: ReadonlyArray<JsonSchemaValidationIssue> | undefined): string {
	if (!issues || issues.length === 0) return "Unknown schema validation error.";
	return issues
		.map(issue => {
			const path = issue.path.length === 0 ? "" : `${issue.path.map(seg => String(seg)).join("/")}: `;
			return `${path}${issue.message}`;
		})
		.join("; ");
}
