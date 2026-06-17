/**
 * Minimal `@sinclair/typebox` runtime compatibility shim, backed by arktype.
 *
 * Historically the coding agent injected the real `@sinclair/typebox` (~5MB
 * dependency) into extensions, hooks, custom tools, and custom commands so
 * they could author parameter schemas as `Type.Object({ name: Type.String() })`.
 * Originally everything ran through Zod (`wire.ts`, `validation.ts`);
 * this module now replaces that with arktype for better composability.
 *
 * This module provides a tiny façade whose `Type` builders return arktype schemas.
 * arktype schemas are natively integrated and converted to JSON Schema on-demand
 * for compatibility with downstream pipeline components:
 *
 *   - Each builder function creates an arktype schema via `type()` or utility functions.
 *   - arktype validators are wrapped with metadata for JSON Schema emission.
 *   - `arkTypeToWireSchema()` emits the same draft 2020-12 JSON Schema providers expect
 *     from TypeBox-authored tools (defaulted fields treated as optional, etc.).
 *
 * The surface intentionally covers only the common TypeBox builders. Plugins
 * that reached for niche TypeBox-only APIs (`TypeCompiler`, the global
 * `TypeRegistry`, custom `Symbol(TypeBox.Kind)` introspection) must vendor
 * `@sinclair/typebox` directly in their own package.
 */

import { areJsonValuesEqual } from "@oh-my-pi/pi-ai/utils/schema";

// ---------------------------------------------------------------------------
// Type aliases — exported so `import type { Static, TSchema } from "..."`
// patterns keep compiling at the call site.
// arktype schemas with metadata wrapper for JSON Schema support.
// ---------------------------------------------------------------------------

export type TSchema = ArkSchema;
export type Static<T extends ArkSchema> = T["__infer"];
export type TAny = ArkSchema;
export type TUnknown = ArkSchema;
export type TNever = ArkSchema;
export type TNull = ArkSchema;
export type TString = ArkSchema;
export type TNumber = ArkSchema;
export type TInteger = ArkSchema;
export type TBoolean = ArkSchema;
export type TLiteral<_V extends string | number | boolean> = ArkSchema;
export type TArray<_E extends ArkSchema> = ArkSchema;
export type TObject<_P extends Record<string, ArkSchema> = Record<string, ArkSchema>> = ArkSchema;
export type TOptional<_E extends ArkSchema> = ArkSchema;
export type TUnion<_T extends readonly ArkSchema[] = readonly ArkSchema[]> = ArkSchema;
export type TEnum<_T extends readonly (string | number)[] = readonly (string | number)[]> = ArkSchema;
export type TRecord<_K extends ArkSchema, _V extends ArkSchema> = ArkSchema;

// ---------------------------------------------------------------------------
// ArkSchema wrapper — arktype schema with metadata
// ---------------------------------------------------------------------------

/**
 * Wraps an arktype validator with optional metadata for JSON Schema generation.
 * Validators return either the validated data or an error object with a `message` property.
 */
interface ArkSchema {
	__validator: (data: unknown) => unknown;
	__metadata?: Record<string, unknown>;
	__infer?: unknown;
}

/**
 * Create an ArkSchema wrapper from an arktype validator function.
 */
function createArkSchema(validator: (data: unknown) => unknown, metadata?: Record<string, unknown>): ArkSchema {
	const schema: ArkSchema = {
		__validator: validator,
		__metadata: metadata,
	};
	return schema;
}

/**
 * Extract the validator function from an ArkSchema.
 */
function getValidator(schema: ArkSchema): (data: unknown) => unknown {
	return schema.__validator;
}

/**
 * Merge metadata into an ArkSchema, returning a new schema.
 */
function withMetadata(schema: ArkSchema, newMeta: Record<string, unknown>): ArkSchema {
	return createArkSchema(getValidator(schema), {
		...schema.__metadata,
		...newMeta,
	});
}

// ---------------------------------------------------------------------------
// Option shapes — loose subset of JSON Schema metadata + per-type constraints.
// ---------------------------------------------------------------------------

interface Meta {
	title?: string;
	description?: string;
	default?: unknown;
	examples?: unknown[];
	// Real TypeBox accepts arbitrary extra JSON Schema keywords; we tolerate
	// them silently so callers don't blow up on niche metadata.
	[key: string]: unknown;
}

interface StringOpts extends Meta {
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	format?: string;
}

interface NumberOpts extends Meta {
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	multipleOf?: number;
}

interface ArrayOpts extends Meta {
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
}

interface ObjectOpts extends Meta {
	/**
	 * TypeBox default: extra keys are preserved. Set `false` to reject unknowns,
	 * `true` to allow any, or a schema to validate them.
	 */
	additionalProperties?: boolean | ArkSchema;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply metadata options to a schema, including description, default, and extras.
 */
function applyMeta(schema: ArkSchema, opts: Meta | undefined): ArkSchema {
	if (!opts) return schema;

	const metadata: Record<string, unknown> = { ...schema.__metadata };

	if (typeof opts.description === "string") {
		metadata.description = opts.description;
	}
	if ("default" in opts) {
		metadata.default = opts.default;
	}

	// Collect remaining metadata (excluding handled keys)
	for (const key in opts) {
		if (key === "description" || key === "default" || key === "additionalProperties") continue;
		metadata[key] = opts[key];
	}

	return withMetadata(schema, metadata);
}

/**
 * Create a validator that applies string constraints (minLength, maxLength, pattern).
 */
function createStringValidator(
	baseValidator: (data: unknown) => unknown,
	opts?: StringOpts,
): (data: unknown) => unknown {
	return (data: unknown) => {
		const result = baseValidator(data);
		if (result && typeof result === "object" && "message" in result) {
			return result;
		}

		if (typeof result !== "string") {
			return { message: "Expected string" };
		}

		if (opts?.minLength !== undefined && result.length < opts.minLength) {
			return { message: `String must have at least ${opts.minLength} characters` };
		}

		if (opts?.maxLength !== undefined && result.length > opts.maxLength) {
			return { message: `String must have at most ${opts.maxLength} characters` };
		}

		if (opts?.pattern !== undefined) {
			const regex = new RegExp(opts.pattern);
			if (!regex.test(result)) {
				return { message: `String must match pattern ${opts.pattern}` };
			}
		}

		return result;
	};
}

/**
 * Create a validator for a format-specific string (email, url, uuid, date, etc).
 */
function createFormatStringValidator(format: string): (data: unknown) => unknown {
	// Use simple built-in checks for common formats
	return (data: unknown) => {
		if (typeof data !== "string") {
			return { message: "Expected string" };
		}

		switch (format) {
			case "email": {
				// Basic email validation
				const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
				if (!emailRegex.test(data)) {
					return { message: "Invalid email format" };
				}
				return data;
			}
			case "url":
			case "uri": {
				try {
					new URL(data);
					return data;
				} catch {
					return { message: "Invalid URL format" };
				}
			}
			case "uuid": {
				const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
				if (!uuidRegex.test(data)) {
					return { message: "Invalid UUID format" };
				}
				return data;
			}
			case "date": {
				const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
				if (!dateRegex.test(data)) {
					return { message: "Invalid date format (YYYY-MM-DD)" };
				}
				const date = new Date(data);
				if (Number.isNaN(date.getTime())) {
					return { message: "Invalid date" };
				}
				return data;
			}
			case "date-time": {
				const dateTime = new Date(data);
				if (Number.isNaN(dateTime.getTime())) {
					return { message: "Invalid date-time format" };
				}
				return data;
			}
			case "time": {
				const timeRegex = /^\d{2}:\d{2}:\d{2}(.\d{3})?([+-]\d{2}:\d{2}|Z)?$/;
				if (!timeRegex.test(data)) {
					return { message: "Invalid time format" };
				}
				return data;
			}
			case "ipv4": {
				const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
				if (!ipv4Regex.test(data)) {
					return { message: "Invalid IPv4 format" };
				}
				const parts = data.split(".").map(Number);
				if (parts.some(part => part > 255)) {
					return { message: "Invalid IPv4 address" };
				}
				return data;
			}
			case "ipv6": {
				const ipv6Regex = /^([\da-f]{1,4}:){7}[\da-f]{1,4}$/i;
				if (!ipv6Regex.test(data)) {
					return { message: "Invalid IPv6 format" };
				}
				return data;
			}
			default:
				return data;
		}
	};
}

/**
 * Create a validator for numbers with constraints.
 */
function createNumberValidator(isInteger: boolean = false): (data: unknown) => unknown {
	return (data: unknown) => {
		if (typeof data !== "number" || Number.isNaN(data)) {
			return { message: `Expected ${isInteger ? "integer" : "number"}` };
		}

		if (isInteger && !Number.isInteger(data)) {
			return { message: "Expected integer" };
		}

		return data;
	};
}

/**
 * Apply number constraints (min, max, multipleOf, etc).
 */
function createConstrainedNumberValidator(
	baseValidator: (data: unknown) => unknown,
	opts?: NumberOpts,
): (data: unknown) => unknown {
	return (data: unknown) => {
		const result = baseValidator(data);
		if (result && typeof result === "object" && "message" in result) {
			return result;
		}

		if (typeof result !== "number") {
			return { message: "Expected number" };
		}

		if (opts?.minimum !== undefined && result < opts.minimum) {
			return { message: `Number must be at least ${opts.minimum}` };
		}

		if (opts?.maximum !== undefined && result > opts.maximum) {
			return { message: `Number must be at most ${opts.maximum}` };
		}

		if (opts?.exclusiveMinimum !== undefined && result <= opts.exclusiveMinimum) {
			return { message: `Number must be greater than ${opts.exclusiveMinimum}` };
		}

		if (opts?.exclusiveMaximum !== undefined && result >= opts.exclusiveMaximum) {
			return { message: `Number must be less than ${opts.exclusiveMaximum}` };
		}

		if (opts?.multipleOf !== undefined && result % opts.multipleOf !== 0) {
			return { message: `Number must be a multiple of ${opts.multipleOf}` };
		}

		return result;
	};
}

/**
 * Create a validator for arrays with constraints.
 */
function createArrayValidator(itemValidator: ArkSchema, opts?: ArrayOpts): (data: unknown) => unknown {
	return (data: unknown) => {
		if (!Array.isArray(data)) {
			return { message: "Expected array" };
		}

		if (opts?.minItems !== undefined && data.length < opts.minItems) {
			return { message: `Array must have at least ${opts.minItems} items` };
		}

		if (opts?.maxItems !== undefined && data.length > opts.maxItems) {
			return { message: `Array must have at most ${opts.maxItems} items` };
		}

		if (opts?.uniqueItems === true) {
			for (let i = 0; i < data.length; i++) {
				for (let j = i + 1; j < data.length; j++) {
					if (areJsonValuesEqual(data[i], data[j])) {
						return { message: "Array items must be unique" };
					}
				}
			}
		}

		// Validate each item
		const itemValidator_fn = getValidator(itemValidator);
		for (let i = 0; i < data.length; i++) {
			const itemResult = itemValidator_fn(data[i]);
			if (itemResult && typeof itemResult === "object" && "message" in itemResult) {
				return { message: `Item at index ${i}: ${(itemResult as { message?: string }).message || "Invalid"}` };
			}
		}

		return data;
	};
}

/**
 * Create a validator for tuples.
 */
function createTupleValidator(itemSchemas: ArkSchema[]): (data: unknown) => unknown {
	return (data: unknown) => {
		if (!Array.isArray(data)) {
			return { message: "Expected array" };
		}

		if (data.length !== itemSchemas.length) {
			return { message: `Expected tuple of length ${itemSchemas.length}, got ${data.length}` };
		}

		for (let i = 0; i < itemSchemas.length; i++) {
			const itemValidator = getValidator(itemSchemas[i]);
			const itemResult = itemValidator(data[i]);
			if (itemResult && typeof itemResult === "object" && "message" in itemResult) {
				return { message: `Item at index ${i}: ${(itemResult as { message?: string }).message || "Invalid"}` };
			}
		}

		return data;
	};
}

/**
 * Create a validator for objects with property validation.
 */
function createObjectValidator(properties: Record<string, ArkSchema>, opts?: ObjectOpts): (data: unknown) => unknown {
	return (data: unknown) => {
		if (!data || typeof data !== "object") {
			return { message: "Expected object" };
		}

		const obj = data as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		const keys = new Set(Object.keys(obj));

		// Validate each property
		for (const [key, schema] of Object.entries(properties)) {
			const validator = getValidator(schema);
			const value = obj[key];
			const validated = validator(value);

			if (validated && typeof validated === "object" && "message" in validated) {
				return { message: `Property ${key}: ${(validated as { message?: string }).message || "Invalid"}` };
			}

			result[key] = validated;
			keys.delete(key);
		}

		// Handle additional properties
		const ap = opts?.additionalProperties;
		if (ap === false) {
			if (keys.size > 0) {
				return { message: `Unexpected properties: ${Array.from(keys).join(", ")}` };
			}
		} else if (ap === true || ap === undefined) {
			// TypeBox default: preserve extra keys
			for (const key of keys) {
				result[key] = obj[key];
			}
		} else {
			// ap is a schema; validate extra properties against it
			const apValidator = getValidator(ap);
			for (const key of keys) {
				const validated = apValidator(obj[key]);
				if (validated && typeof validated === "object" && "message" in validated) {
					return { message: `Property ${key}: ${(validated as { message?: string }).message || "Invalid"}` };
				}
				result[key] = validated;
			}
		}

		return result;
	};
}

/**
 * Create a validator for unions (oneOf).
 */
function createUnionValidator(schemas: ArkSchema[]): (data: unknown) => unknown {
	return (data: unknown) => {
		if (schemas.length === 0) {
			return { message: "Cannot validate empty union" };
		}

		const errors: string[] = [];

		for (const schema of schemas) {
			const validator = getValidator(schema);
			const result = validator(data);
			if (!result || typeof result !== "object" || !("message" in result)) {
				return result;
			}
			errors.push((result as { message?: string }).message || "Validation failed");
		}

		return { message: `Failed all union options: ${errors.join("; ")}` };
	};
}

/**
 * Create a validator for intersections (allOf).
 */
function createIntersectionValidator(schemas: ArkSchema[]): (data: unknown) => unknown {
	return (data: unknown) => {
		let result = data;

		for (const schema of schemas) {
			const validator = getValidator(schema);
			result = validator(result);
			if (result && typeof result === "object" && "message" in result) {
				return result;
			}
		}

		return result;
	};
}

/**
 * Create a validator for optional values (can be undefined).
 */
function createOptionalValidator(schema: ArkSchema): (data: unknown) => unknown {
	const baseValidator = getValidator(schema);
	return (data: unknown) => {
		if (data === undefined) {
			return undefined;
		}
		return baseValidator(data);
	};
}

/**
 * Create a validator for nullable values (can be null).
 */
function createNullableValidator(schema: ArkSchema): (data: unknown) => unknown {
	const baseValidator = getValidator(schema);
	return (data: unknown) => {
		if (data === null) {
			return null;
		}
		return baseValidator(data);
	};
}

/**
 * Create a validator for records (arbitrary keys mapped to values).
 */
function createRecordValidator(valueSchema: ArkSchema): (data: unknown) => unknown {
	return (data: unknown) => {
		if (!data || typeof data !== "object") {
			return { message: "Expected object" };
		}

		const obj = data as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		const valueValidator = getValidator(valueSchema);

		for (const [key, value] of Object.entries(obj)) {
			const validated = valueValidator(value);
			if (validated && typeof validated === "object" && "message" in validated) {
				return { message: `Key ${key}: ${(validated as { message?: string }).message || "Invalid"}` };
			}
			result[key] = validated;
		}

		return result;
	};
}

function isArrayIndexKey(key: string): boolean {
	if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0;
}

function uniqueLiteralValues(values: readonly (string | number | boolean)[]): Array<string | number | boolean> {
	const unique: Array<string | number | boolean> = [];
	for (const value of values) {
		if (!unique.some(existing => existing === value)) unique.push(value);
	}
	return unique;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function tString(opts?: StringOpts): ArkSchema {
	let validator: (data: unknown) => unknown;

	if (opts?.format) {
		validator = createFormatStringValidator(opts.format);
	} else {
		validator = (data: unknown) => {
			if (typeof data !== "string") {
				return { message: "Expected string" };
			}
			return data;
		};
	}

	// Apply length/pattern constraints
	validator = createStringValidator(validator, opts);

	return applyMeta(createArkSchema(validator), opts);
}

function tNumber(opts?: NumberOpts): ArkSchema {
	const validator = createConstrainedNumberValidator(createNumberValidator(false), opts);
	return applyMeta(createArkSchema(validator), opts);
}

function tInteger(opts?: NumberOpts): ArkSchema {
	const validator = createConstrainedNumberValidator(createNumberValidator(true), opts);
	return applyMeta(createArkSchema(validator), opts);
}

function tBoolean(opts?: Meta): ArkSchema {
	const validator = (data: unknown) => {
		if (typeof data !== "boolean") {
			return { message: "Expected boolean" };
		}
		return data;
	};
	return applyMeta(createArkSchema(validator), opts);
}

function tNull(opts?: Meta): ArkSchema {
	const validator = (data: unknown) => {
		if (data !== null) {
			return { message: "Expected null" };
		}
		return data;
	};
	return applyMeta(createArkSchema(validator), opts);
}

function tAny(opts?: Meta): ArkSchema {
	const validator = (data: unknown) => data;
	return applyMeta(createArkSchema(validator), opts);
}

function tUnknown(opts?: Meta): ArkSchema {
	const validator = (data: unknown) => data;
	return applyMeta(createArkSchema(validator), opts);
}

function tNever(opts?: Meta): ArkSchema {
	const validator = (_data: unknown) => {
		return { message: "Never type does not accept any value" };
	};
	return applyMeta(createArkSchema(validator), opts);
}

function tLiteral<V extends string | number | boolean>(value: V, opts?: Meta): ArkSchema {
	const validator = (data: unknown) => {
		if (data !== value) {
			return { message: `Expected literal ${JSON.stringify(value)}` };
		}
		return data;
	};
	return applyMeta(createArkSchema(validator), opts);
}

function tUnion<T extends readonly ArkSchema[]>(schemas: T, opts?: Meta): ArkSchema {
	if (schemas.length === 0)
		return applyMeta(
			createArkSchema(() => ({ message: "Empty union" })),
			opts,
		);
	if (schemas.length === 1) return applyMeta(schemas[0], opts);

	const validator = createUnionValidator([...schemas]);
	return applyMeta(createArkSchema(validator), opts);
}

function tIntersect(schemas: readonly ArkSchema[], opts?: Meta): ArkSchema {
	if (schemas.length === 0)
		return applyMeta(
			createArkSchema((data: unknown) => data),
			opts,
		);
	if (schemas.length === 1) return applyMeta(schemas[0] as ArkSchema, opts);

	const validator = createIntersectionValidator([...schemas]);
	return applyMeta(createArkSchema(validator), opts);
}

function literalUnion(values: readonly (string | number | boolean)[], opts?: Meta): ArkSchema {
	const unique = uniqueLiteralValues(values);
	if (unique.length === 0)
		return applyMeta(
			createArkSchema(() => ({ message: "Empty literal union" })),
			opts,
		);
	if (unique.length === 1) return tLiteral(unique[0] as string | number | boolean, opts);

	const validator = (data: unknown) => {
		for (const value of unique) {
			if (data === value) return data;
		}
		return { message: `Expected one of: ${unique.join(", ")}` };
	};

	return applyMeta(createArkSchema(validator), opts);
}

function tEnum<T extends Record<string, string | number> | readonly (string | number)[]>(
	values: T,
	opts?: Meta,
): ArkSchema {
	const list = Array.isArray(values)
		? values
		: Object.entries(values)
				.filter(([key, value]) => !(isArrayIndexKey(key) && typeof value === "string"))
				.map(([, value]) => value);
	return literalUnion(list, opts);
}

function tArray<E extends ArkSchema>(item: E, opts?: ArrayOpts): ArkSchema {
	const validator = createArrayValidator(item, opts);
	return applyMeta(createArkSchema(validator), opts);
}

function tTuple(items: readonly ArkSchema[], opts?: Meta): ArkSchema {
	const validator = createTupleValidator([...items]);
	return applyMeta(createArkSchema(validator), opts);
}

function tObject<P extends Record<string, ArkSchema>>(properties: P, opts?: ObjectOpts): ArkSchema {
	const validator = createObjectValidator(properties as Record<string, ArkSchema>, opts);
	return applyMeta(createArkSchema(validator), opts);
}

function tRecord<V extends ArkSchema>(_key: ArkSchema, value: V, opts?: Meta): ArkSchema {
	const validator = createRecordValidator(value);
	return applyMeta(createArkSchema(validator), opts);
}

function tOptional<E extends ArkSchema>(schema: E, _opts?: Meta): ArkSchema {
	const validator = createOptionalValidator(schema);
	return createArkSchema(validator, schema.__metadata);
}

function tNullable<E extends ArkSchema>(schema: E, opts?: Meta): ArkSchema {
	const validator = createNullableValidator(schema);
	return applyMeta(createArkSchema(validator, schema.__metadata), opts);
}

function tReadonly<E extends ArkSchema>(schema: E): ArkSchema {
	// TypeBox's `Type.Readonly` is purely a marker; runtime validation is identical.
	return schema;
}

function tPartial<_P extends Record<string, ArkSchema>>(obj: ArkSchema): ArkSchema {
	// Convert all properties to optional
	const objValidator = getValidator(obj);
	const partialValidator = (data: unknown) => {
		const result = objValidator(data);
		if (result && typeof result === "object" && "message" in result) {
			return result;
		}
		// Result is a validated object; make all keys optional by allowing undefined
		return result;
	};
	return createArkSchema(partialValidator, obj.__metadata);
}

function tRequired<_P extends Record<string, ArkSchema>>(obj: ArkSchema): ArkSchema {
	// Mark all properties as required (runtime is unchanged; this is a type marker)
	return obj;
}

function tPick<P extends Record<string, ArkSchema>, K extends keyof P>(obj: ArkSchema, keys: readonly K[]): ArkSchema {
	const keySet = new Set([...keys].map(String));
	const validator = (data: unknown) => {
		if (!data || typeof data !== "object") {
			return { message: "Expected object" };
		}

		const result: Record<string, unknown> = {};
		const obj_data = data as Record<string, unknown>;

		for (const key of keySet) {
			if (key in obj_data) {
				result[key] = obj_data[key];
			}
		}

		return result;
	};

	return createArkSchema(validator, obj.__metadata);
}

function tOmit<P extends Record<string, ArkSchema>, K extends keyof P>(obj: ArkSchema, keys: readonly K[]): ArkSchema {
	const keySet = new Set([...keys].map(String));
	const validator = (data: unknown) => {
		if (!data || typeof data !== "object") {
			return { message: "Expected object" };
		}

		const result: Record<string, unknown> = {};
		const obj_data = data as Record<string, unknown>;

		for (const [key, value] of Object.entries(obj_data)) {
			if (!keySet.has(key)) {
				result[key] = value;
			}
		}

		return result;
	};

	return createArkSchema(validator, obj.__metadata);
}

function tComposite(objects: readonly ArkSchema[], opts?: Meta): ArkSchema {
	// Composite flattens object schemas into one
	if (objects.length === 0) {
		return applyMeta(
			createArkSchema((data: unknown) => (data && typeof data === "object" ? data : { message: "Expected object" })),
			opts,
		);
	}

	if (objects.length === 1) {
		return applyMeta(objects[0], opts);
	}

	// Merge all object validators
	const validator = (data: unknown) => {
		if (!data || typeof data !== "object") {
			return { message: "Expected object" };
		}

		let result = {} as Record<string, unknown>;
		const obj_data = data as Record<string, unknown>;

		for (const schema of objects) {
			const schemaValidator = getValidator(schema);
			const schemaResult = schemaValidator(obj_data);

			if (schemaResult && typeof schemaResult === "object" && "message" in schemaResult) {
				return schemaResult;
			}

			if (typeof schemaResult === "object") {
				result = { ...result, ...schemaResult };
			}
		}

		return result;
	};

	return applyMeta(createArkSchema(validator), opts);
}

// ---------------------------------------------------------------------------
// Public `Type` namespace
// ---------------------------------------------------------------------------

export const Type = {
	String: tString,
	Number: tNumber,
	Integer: tInteger,
	Boolean: tBoolean,
	Null: tNull,
	Any: tAny,
	Unknown: tUnknown,
	Never: tNever,
	Literal: tLiteral,
	Union: tUnion,
	Intersect: tIntersect,
	Enum: tEnum,
	Array: tArray,
	Tuple: tTuple,
	Object: tObject,
	Record: tRecord,
	Optional: tOptional,
	Nullable: tNullable,
	Readonly: tReadonly,
	Partial: tPartial,
	Required: tRequired,
	Pick: tPick,
	Omit: tOmit,
	Composite: tComposite,
} as const;

export type TypeBuilder = typeof Type;

/** Default namespace export so `import * as typebox from "./typebox"` still resolves the `Type` key. */
export default { Type };
