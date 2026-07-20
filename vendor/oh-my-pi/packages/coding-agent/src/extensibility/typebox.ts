/**
 * Minimal `@sinclair/typebox` runtime compatibility shim.
 *
 * Historically the coding agent injected the real `@sinclair/typebox` (~5MB
 * dependency) into extensions, hooks, custom tools, and custom commands so
 * they could author parameter schemas as `Type.Object({ name: Type.String() })`.
 *
 * This module provides the subset those integrations depend on:
 *
 *   - TypeBox-style `Type.*` builders.
 *   - Runtime validation through `schema.safeParse(input)` and `schema.__validator(input)`.
 *   - Enumerable JSON Schema keywords so `{ ...schema }`, `JSON.stringify(schema)`,
 *     and `toolWireSchema({ parameters: schema })` all see the same schema.
 *
 * Internal validator fields and methods are intentionally non-enumerable. The
 * object should look like JSON Schema at every serialization/wire boundary and
 * like a small validator at runtime.
 */

import { areJsonValuesEqual } from "@oh-my-pi/pi-ai/utils/schema";

// ---------------------------------------------------------------------------
// Type aliases — exported so `import type { Static, TSchema } from "..."`
// patterns keep compiling at the call site.
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
// ArkSchema wrapper — JSON Schema object with hidden validator metadata
// ---------------------------------------------------------------------------

const VALIDATION_FAILURE = Symbol("pi.typebox.validationFailure");

interface ValidationFailure {
	message: string;
	readonly [VALIDATION_FAILURE]: true;
}

interface SafeParseSuccess {
	success: true;
	data: unknown;
}

interface SafeParseFailure {
	success: false;
	error: ValidationFailure;
}

interface SchemaInternals {
	optional?: boolean;
	metadata?: Record<string, unknown>;
	properties?: Record<string, ArkSchema>;
	additionalProperties?: boolean | ArkSchema;
	inner?: ArkSchema;
}

/**
 * JSON-Schema-shaped object with non-enumerable runtime helpers.
 * Validators return the validated data or a marked `{ message }` failure.
 */
interface ArkSchema {
	__validator: (data: unknown) => unknown;
	__metadata?: Record<string, unknown>;
	__optional?: true;
	__properties?: Record<string, ArkSchema>;
	__additionalProperties?: boolean | ArkSchema;
	__infer?: unknown;
	__inner?: ArkSchema;
	safeParse(input: unknown): SafeParseSuccess | SafeParseFailure;
	toJSON(): Record<string, unknown>;
	[key: string]: unknown;
}

function defineHidden(target: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		configurable: true,
	});
}

function validationFailure(message: string): ValidationFailure {
	const failure = { message } as ValidationFailure;
	defineHidden(failure, VALIDATION_FAILURE, true);
	return failure;
}

function isValidationFailure(value: unknown): value is ValidationFailure {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as { readonly [VALIDATION_FAILURE]?: unknown };
	return candidate[VALIDATION_FAILURE] === true;
}

function schemaJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(schemaJsonValue);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const key in value) {
		result[key] = schemaJsonValue((value as Record<string, unknown>)[key]);
	}
	return result;
}

function jsonSchemaOf(schema: ArkSchema): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key in schema) result[key] = schemaJsonValue(schema[key]);
	return result;
}

function createArkSchema(
	validator: (data: unknown) => unknown,
	jsonSchema: Record<string, unknown> = {},
	internals: SchemaInternals = {},
): ArkSchema {
	const schema = { ...jsonSchema } as ArkSchema;
	const metadata = internals.metadata ?? {};
	defineHidden(schema, "__validator", validator);
	defineHidden(schema, "__metadata", metadata);
	if (internals.optional) defineHidden(schema, "__optional", true);
	if (internals.properties) defineHidden(schema, "__properties", internals.properties);
	if (internals.additionalProperties !== undefined) {
		defineHidden(schema, "__additionalProperties", internals.additionalProperties);
	}
	if (internals.inner) defineHidden(schema, "__inner", internals.inner);
	defineHidden(schema, "safeParse", (input: unknown): SafeParseSuccess | SafeParseFailure => {
		const result = validator(input);
		if (isValidationFailure(result)) return { success: false, error: result };
		return { success: true, data: result };
	});
	defineHidden(schema, "toJSON", () => jsonSchemaOf(schema));
	return schema;
}

function cloneSchemaWith(
	schema: ArkSchema,
	jsonSchema: Record<string, unknown>,
	internals?: SchemaInternals,
): ArkSchema {
	return createArkSchema(schema.__validator, jsonSchema, {
		metadata: internals?.metadata ?? schema.__metadata,
		optional: internals?.optional ?? schema.__optional === true,
		properties: internals?.properties ?? schema.__properties,
		additionalProperties: internals?.additionalProperties ?? schema.__additionalProperties,
		inner: internals?.inner ?? schema.__inner,
	});
}

function withMetadata(schema: ArkSchema, newMeta: Record<string, unknown>): ArkSchema {
	return cloneSchemaWith(
		schema,
		{ ...jsonSchemaOf(schema), ...newMeta },
		{
			metadata: { ...(schema.__metadata ?? {}), ...newMeta },
		},
	);
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

function applyMeta(schema: ArkSchema, opts: Meta | undefined): ArkSchema {
	if (!opts) return schema;
	const metadata: Record<string, unknown> = {};
	for (const key in opts) {
		if (key === "additionalProperties") continue;
		metadata[key] = opts[key];
	}
	return withMetadata(schema, metadata);
}

function createStringValidator(
	baseValidator: (data: unknown) => unknown,
	opts?: StringOpts,
): (data: unknown) => unknown {
	return (data: unknown) => {
		const result = baseValidator(data);
		if (isValidationFailure(result)) return result;
		if (typeof result !== "string") return validationFailure("Expected string");
		if (opts?.minLength !== undefined && result.length < opts.minLength) {
			return validationFailure(`String must have at least ${opts.minLength} characters`);
		}
		if (opts?.maxLength !== undefined && result.length > opts.maxLength) {
			return validationFailure(`String must have at most ${opts.maxLength} characters`);
		}
		if (opts?.pattern !== undefined) {
			const regex = new RegExp(opts.pattern);
			if (!regex.test(result)) return validationFailure(`String must match pattern ${opts.pattern}`);
		}
		return result;
	};
}

function createFormatStringValidator(format: string): (data: unknown) => unknown {
	return (data: unknown) => {
		if (typeof data !== "string") return validationFailure("Expected string");
		switch (format) {
			case "email": {
				const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
				return emailRegex.test(data) ? data : validationFailure("Invalid email format");
			}
			case "url":
			case "uri":
				try {
					new URL(data);
					return data;
				} catch {
					return validationFailure("Invalid URL format");
				}
			case "uuid": {
				const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
				return uuidRegex.test(data) ? data : validationFailure("Invalid UUID format");
			}
			case "date": {
				const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
				if (!dateRegex.test(data)) return validationFailure("Invalid date format (YYYY-MM-DD)");
				const date = new Date(data);
				return Number.isNaN(date.getTime()) ? validationFailure("Invalid date") : data;
			}
			case "date-time": {
				const dateTime = new Date(data);
				return Number.isNaN(dateTime.getTime()) ? validationFailure("Invalid date-time format") : data;
			}
			case "time": {
				const timeRegex = /^\d{2}:\d{2}:\d{2}(.\d{3})?([+-]\d{2}:\d{2}|Z)?$/;
				return timeRegex.test(data) ? data : validationFailure("Invalid time format");
			}
			case "ipv4": {
				const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
				if (!ipv4Regex.test(data)) return validationFailure("Invalid IPv4 format");
				const parts = data.split(".").map(Number);
				return parts.some(part => part > 255) ? validationFailure("Invalid IPv4 address") : data;
			}
			case "ipv6": {
				const ipv6Regex = /^([\da-f]{1,4}:){7}[\da-f]{1,4}$/i;
				return ipv6Regex.test(data) ? data : validationFailure("Invalid IPv6 format");
			}
			default:
				return data;
		}
	};
}

function createNumberValidator(isInteger = false): (data: unknown) => unknown {
	return (data: unknown) => {
		if (typeof data !== "number" || Number.isNaN(data)) {
			return validationFailure(`Expected ${isInteger ? "integer" : "number"}`);
		}
		if (isInteger && !Number.isInteger(data)) return validationFailure("Expected integer");
		return data;
	};
}

function createConstrainedNumberValidator(
	baseValidator: (data: unknown) => unknown,
	opts?: NumberOpts,
): (data: unknown) => unknown {
	return (data: unknown) => {
		const result = baseValidator(data);
		if (isValidationFailure(result)) return result;
		if (typeof result !== "number") return validationFailure("Expected number");
		if (opts?.minimum !== undefined && result < opts.minimum) {
			return validationFailure(`Number must be at least ${opts.minimum}`);
		}
		if (opts?.maximum !== undefined && result > opts.maximum) {
			return validationFailure(`Number must be at most ${opts.maximum}`);
		}
		if (opts?.exclusiveMinimum !== undefined && result <= opts.exclusiveMinimum) {
			return validationFailure(`Number must be greater than ${opts.exclusiveMinimum}`);
		}
		if (opts?.exclusiveMaximum !== undefined && result >= opts.exclusiveMaximum) {
			return validationFailure(`Number must be less than ${opts.exclusiveMaximum}`);
		}
		if (opts?.multipleOf !== undefined && result % opts.multipleOf !== 0) {
			return validationFailure(`Number must be a multiple of ${opts.multipleOf}`);
		}
		return result;
	};
}

function createArrayValidator(itemValidator: ArkSchema, opts?: ArrayOpts): (data: unknown) => unknown {
	return (data: unknown) => {
		if (!Array.isArray(data)) return validationFailure("Expected array");
		if (opts?.minItems !== undefined && data.length < opts.minItems) {
			return validationFailure(`Array must have at least ${opts.minItems} items`);
		}
		if (opts?.maxItems !== undefined && data.length > opts.maxItems) {
			return validationFailure(`Array must have at most ${opts.maxItems} items`);
		}
		if (opts?.uniqueItems === true) {
			for (let i = 0; i < data.length; i++) {
				for (let j = i + 1; j < data.length; j++) {
					if (areJsonValuesEqual(data[i], data[j])) return validationFailure("Array items must be unique");
				}
			}
		}
		const itemValidatorFn = itemValidator.__validator;
		for (let i = 0; i < data.length; i++) {
			const itemResult = itemValidatorFn(data[i]);
			if (isValidationFailure(itemResult)) {
				return validationFailure(`Item at index ${i}: ${itemResult.message || "Invalid"}`);
			}
		}
		return data;
	};
}

function createTupleValidator(itemSchemas: ArkSchema[]): (data: unknown) => unknown {
	return (data: unknown) => {
		if (!Array.isArray(data)) return validationFailure("Expected array");
		if (data.length !== itemSchemas.length) {
			return validationFailure(`Expected tuple of length ${itemSchemas.length}, got ${data.length}`);
		}
		for (let i = 0; i < itemSchemas.length; i++) {
			const itemValidator = itemSchemas[i].__validator;
			const itemResult = itemValidator(data[i]);
			if (isValidationFailure(itemResult)) {
				return validationFailure(`Item at index ${i}: ${itemResult.message || "Invalid"}`);
			}
		}
		return data;
	};
}

function createObjectValidator(properties: Record<string, ArkSchema>, opts?: ObjectOpts): (data: unknown) => unknown {
	return (data: unknown) => {
		if (!data || typeof data !== "object") return validationFailure("Expected object");
		const obj = data as Record<string, unknown>;
		const result: Record<string, unknown> = {};

		const keys = new Set<string>();
		for (const key in obj) {
			keys.add(key);
		}

		for (const key in properties) {
			const schema = properties[key];
			const validated = schema.__validator(obj[key]);
			if (isValidationFailure(validated)) {
				return validationFailure(`Property ${key}: ${validated.message || "Invalid"}`);
			}
			if (obj[key] !== undefined || schema.__optional !== true) {
				result[key] = validated;
			}
			keys.delete(key);
		}

		const additionalProperties = opts?.additionalProperties;
		if (additionalProperties === false) {
			if (keys.size > 0) return validationFailure(`Unexpected properties: ${Array.from(keys).join(", ")}`);
		} else if (additionalProperties === true || additionalProperties === undefined) {
			for (const key of keys) result[key] = obj[key];
		} else {
			const additionalValidator = additionalProperties.__validator;
			for (const key of keys) {
				const validated = additionalValidator(obj[key]);
				if (isValidationFailure(validated)) {
					return validationFailure(`Property ${key}: ${validated.message || "Invalid"}`);
				}
				result[key] = validated;
			}
		}
		return result;
	};
}

function createUnionValidator(schemas: ArkSchema[]): (data: unknown) => unknown {
	return (data: unknown) => {
		if (schemas.length === 0) return validationFailure("Cannot validate empty union");
		const errors: string[] = [];
		for (const schema of schemas) {
			const result = schema.__validator(data);
			if (!isValidationFailure(result)) return result;
			errors.push(result.message || "Invalid");
		}
		return validationFailure(`Failed all union options: ${errors.join("; ")}`);
	};
}

function createIntersectionValidator(schemas: ArkSchema[]): (data: unknown) => unknown {
	return (data: unknown) => {
		let result = data;
		for (const schema of schemas) {
			result = schema.__validator(result);
			if (isValidationFailure(result)) return result;
		}
		return result;
	};
}

function createOptionalValidator(schema: ArkSchema): (data: unknown) => unknown {
	const baseValidator = schema.__validator;
	return (data: unknown) => (data === undefined ? undefined : baseValidator(data));
}

function createNullableValidator(schema: ArkSchema): (data: unknown) => unknown {
	const baseValidator = schema.__validator;
	return (data: unknown) => (data === null ? null : baseValidator(data));
}

function createRecordValidator(keySchema: ArkSchema, valueSchema: ArkSchema): (data: unknown) => unknown {
	return (data: unknown) => {
		if (!data || typeof data !== "object") return validationFailure("Expected object");
		const obj = data as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		const keyValidator = keySchema.__validator;
		const valueValidator = valueSchema.__validator;
		for (const key in obj) {
			const value = obj[key];
			const keyResult = keyValidator(key);
			if (isValidationFailure(keyResult)) {
				return validationFailure(`Key ${key}: ${keyResult.message || "Invalid"}`);
			}
			const valueResult = valueValidator(value);
			if (isValidationFailure(valueResult)) {
				return validationFailure(`Key ${key}: ${valueResult.message || "Invalid"}`);
			}
			result[key] = valueResult;
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

function requiredKeys(properties: Record<string, ArkSchema>): string[] | undefined {
	const required: string[] = [];
	for (const key in properties) {
		if (properties[key].__optional !== true) {
			required.push(key);
		}
	}
	return required.length === 0 ? undefined : required;
}

function objectJsonSchema(properties: Record<string, ArkSchema>, opts?: ObjectOpts): Record<string, unknown> {
	const propertySchemas: Record<string, unknown> = {};
	for (const key in properties) propertySchemas[key] = jsonSchemaOf(properties[key]);
	const schema: Record<string, unknown> = { type: "object", properties: propertySchemas };
	const required = requiredKeys(properties);
	if (required) schema.required = required;
	const additionalProperties = opts?.additionalProperties;
	if (additionalProperties !== undefined) {
		schema.additionalProperties =
			typeof additionalProperties === "boolean" ? additionalProperties : jsonSchemaOf(additionalProperties);
	}
	return schema;
}

function schemaWithoutOptional(schema: ArkSchema): ArkSchema {
	const base = schema.__inner ?? schema;
	return createArkSchema(base.__validator, jsonSchemaOf(base), {
		metadata: base.__metadata,
		properties: base.__properties,
		additionalProperties: base.__additionalProperties,
	});
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function tString(opts?: StringOpts): ArkSchema {
	let validator: (data: unknown) => unknown = opts?.format
		? createFormatStringValidator(opts.format)
		: (data: unknown) => (typeof data === "string" ? data : validationFailure("Expected string"));
	validator = createStringValidator(validator, opts);
	return applyMeta(createArkSchema(validator, { type: "string" }), opts);
}

function tNumber(opts?: NumberOpts): ArkSchema {
	const validator = createConstrainedNumberValidator(createNumberValidator(false), opts);
	return applyMeta(createArkSchema(validator, { type: "number" }), opts);
}

function tInteger(opts?: NumberOpts): ArkSchema {
	const validator = createConstrainedNumberValidator(createNumberValidator(true), opts);
	return applyMeta(createArkSchema(validator, { type: "integer" }), opts);
}

function tBoolean(opts?: Meta): ArkSchema {
	const validator = (data: unknown) => (typeof data === "boolean" ? data : validationFailure("Expected boolean"));
	return applyMeta(createArkSchema(validator, { type: "boolean" }), opts);
}

function tNull(opts?: Meta): ArkSchema {
	const validator = (data: unknown) => (data === null ? data : validationFailure("Expected null"));
	return applyMeta(createArkSchema(validator, { type: "null" }), opts);
}

function tAny(opts?: Meta): ArkSchema {
	return applyMeta(
		createArkSchema((data: unknown) => data, {}),
		opts,
	);
}

function tUnknown(opts?: Meta): ArkSchema {
	return applyMeta(
		createArkSchema((data: unknown) => data, {}),
		opts,
	);
}

function tNever(opts?: Meta): ArkSchema {
	return applyMeta(
		createArkSchema(() => validationFailure("Never type does not accept any value"), { not: {} }),
		opts,
	);
}

function tLiteral<V extends string | number | boolean>(value: V, opts?: Meta): ArkSchema {
	const validator = (data: unknown) =>
		data === value ? data : validationFailure(`Expected literal ${JSON.stringify(value)}`);
	return applyMeta(createArkSchema(validator, { const: value }), opts);
}

function tUnion<T extends readonly ArkSchema[]>(schemas: T, opts?: Meta): ArkSchema {
	if (schemas.length === 0)
		return applyMeta(
			createArkSchema(() => validationFailure("Empty union"), { not: {} }),
			opts,
		);
	if (schemas.length === 1) return applyMeta(schemas[0], opts);
	const validator = createUnionValidator([...schemas]);
	return applyMeta(createArkSchema(validator, { anyOf: schemas.map(jsonSchemaOf) }), opts);
}

function tIntersect(schemas: readonly ArkSchema[], opts?: Meta): ArkSchema {
	if (schemas.length === 0)
		return applyMeta(
			createArkSchema((data: unknown) => data, {}),
			opts,
		);
	if (schemas.length === 1) return applyMeta(schemas[0], opts);
	const validator = createIntersectionValidator([...schemas]);
	return applyMeta(createArkSchema(validator, { allOf: schemas.map(jsonSchemaOf) }), opts);
}

function literalUnion(values: readonly (string | number | boolean)[], opts?: Meta): ArkSchema {
	const unique = uniqueLiteralValues(values);
	if (unique.length === 0)
		return applyMeta(
			createArkSchema(() => validationFailure("Empty literal union"), { not: {} }),
			opts,
		);
	if (unique.length === 1) return tLiteral(unique[0] as string | number | boolean, opts);
	const validator = (data: unknown) => {
		for (const value of unique) if (data === value) return data;
		return validationFailure(`Expected one of: ${unique.join(", ")}`);
	};
	return applyMeta(createArkSchema(validator, { enum: unique }), opts);
}

function tEnum<T extends Record<string, string | number> | readonly (string | number)[]>(
	values: T,
	opts?: Meta,
): ArkSchema {
	let list: (string | number)[];
	if (Array.isArray(values)) {
		list = values;
	} else {
		list = [];
		for (const key in values) {
			const value = values[key];
			if (!(isArrayIndexKey(key) && typeof value === "string")) {
				list.push(value as string | number);
			}
		}
	}
	return literalUnion(list, opts);
}

function tArray<E extends ArkSchema>(item: E, opts?: ArrayOpts): ArkSchema {
	const validator = createArrayValidator(item, opts);
	return applyMeta(createArkSchema(validator, { type: "array", items: jsonSchemaOf(item) }), opts);
}

function tTuple(items: readonly ArkSchema[], opts?: Meta): ArkSchema {
	const validator = createTupleValidator([...items]);
	return applyMeta(
		createArkSchema(validator, {
			type: "array",
			prefixItems: items.map(jsonSchemaOf),
			minItems: items.length,
			maxItems: items.length,
		}),
		opts,
	);
}

function tObject<P extends Record<string, ArkSchema>>(properties: P, opts?: ObjectOpts): ArkSchema {
	const props = properties as Record<string, ArkSchema>;
	const validator = createObjectValidator(props, opts);
	const schema = createArkSchema(validator, objectJsonSchema(props, opts), {
		properties: props,
		additionalProperties: opts?.additionalProperties,
	});
	return applyMeta(schema, opts);
}

function literalRecordKeys(keySchema: ArkSchema): string[] | null {
	const json = jsonSchemaOf(keySchema);
	if ("const" in json) return [String(json.const)];
	const values = json.enum;
	if (!Array.isArray(values)) return null;
	const keys: string[] = [];
	for (const value of values) {
		const type = typeof value;
		if (type !== "string" && type !== "number" && type !== "boolean") return null;
		keys.push(String(value));
	}
	return keys;
}

function createRecordJson(keySchema: ArkSchema, valueSchema: ArkSchema): Record<string, unknown> {
	const valueJson = jsonSchemaOf(valueSchema);
	const keys = literalRecordKeys(keySchema);
	if (keys) {
		const properties: Record<string, unknown> = {};
		for (const key of keys) properties[key] = valueJson;
		return { type: "object", properties, required: keys, additionalProperties: false };
	}
	const json: Record<string, unknown> = { type: "object", additionalProperties: valueJson };
	const keyJson = jsonSchemaOf(keySchema);
	if (Object.keys(keyJson).length > 0) json.propertyNames = keyJson;
	return json;
}

function tRecord<K extends ArkSchema, V extends ArkSchema>(key: K, value: V, opts?: Meta): ArkSchema {
	const validator = createRecordValidator(key, value);
	return applyMeta(createArkSchema(validator, createRecordJson(key, value)), opts);
}

function tOptional<E extends ArkSchema>(schema: E, opts?: Meta): ArkSchema {
	const validator = createOptionalValidator(schema);
	const optional = createArkSchema(validator, jsonSchemaOf(schema), {
		optional: true,
		inner: schema,
	});
	return applyMeta(optional, opts);
}

function tNullable<E extends ArkSchema>(schema: E, opts?: Meta): ArkSchema {
	const validator = createNullableValidator(schema);
	return applyMeta(createArkSchema(validator, { anyOf: [jsonSchemaOf(schema), { type: "null" }] }), opts);
}

function tReadonly<E extends ArkSchema>(schema: E): ArkSchema {
	// TypeBox's `Type.Readonly` is purely a marker; runtime validation is identical.
	return schema;
}

function tPartial<_P extends Record<string, ArkSchema>>(obj: ArkSchema): ArkSchema {
	if (obj.__properties) {
		const properties: Record<string, ArkSchema> = {};
		for (const key in obj.__properties) {
			const schema = obj.__properties[key];
			properties[key] = schema.__optional === true ? schema : tOptional(schema);
		}
		return tObject(properties, { additionalProperties: obj.__additionalProperties });
	}
	const objValidator = obj.__validator;
	const metadata = jsonSchemaOf(obj);
	delete metadata.required;
	return createArkSchema(objValidator, metadata);
}

function tRequired<_P extends Record<string, ArkSchema>>(obj: ArkSchema): ArkSchema {
	if (obj.__properties) {
		const properties: Record<string, ArkSchema> = {};
		for (const key in obj.__properties) {
			properties[key] = schemaWithoutOptional(obj.__properties[key]);
		}
		return tObject(properties, { additionalProperties: obj.__additionalProperties });
	}
	const metadata = jsonSchemaOf(obj);
	if (metadata.properties && typeof metadata.properties === "object" && !Array.isArray(metadata.properties)) {
		const properties = metadata.properties as Record<string, unknown>;
		const required: string[] = [];
		for (const key in properties) {
			required.push(key);
		}
		metadata.required = required;
	}
	return createArkSchema(obj.__validator, metadata);
}

function tPick<P extends Record<string, ArkSchema>, K extends keyof P>(obj: ArkSchema, keys: readonly K[]): ArkSchema {
	const keySet = new Set([...keys].map(String));
	if (obj.__properties) {
		const properties: Record<string, ArkSchema> = {};
		for (const key of keySet) {
			const schema = obj.__properties[key];
			if (schema) properties[key] = schema;
		}
		return tObject(properties, { additionalProperties: obj.__additionalProperties });
	}
	const validator = (data: unknown) => {
		if (!data || typeof data !== "object") {
			return validationFailure("Expected object");
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

	const metadata = jsonSchemaOf(obj);
	if (metadata.properties && typeof metadata.properties === "object" && !Array.isArray(metadata.properties)) {
		const properties = metadata.properties as Record<string, unknown>;
		const filteredProps: Record<string, unknown> = {};
		for (const key in properties) {
			if (keySet.has(key)) {
				filteredProps[key] = properties[key];
			}
		}
		metadata.properties = filteredProps;
	}
	if (Array.isArray(metadata.required)) {
		metadata.required = metadata.required.filter(key => typeof key === "string" && keySet.has(key));
	}
	return createArkSchema(validator, metadata);
}

function tOmit<P extends Record<string, ArkSchema>, K extends keyof P>(obj: ArkSchema, keys: readonly K[]): ArkSchema {
	const keySet = new Set([...keys].map(String));
	if (obj.__properties) {
		const properties: Record<string, ArkSchema> = {};
		for (const key in obj.__properties) {
			if (!keySet.has(key)) {
				properties[key] = obj.__properties[key];
			}
		}
		return tObject(properties, { additionalProperties: obj.__additionalProperties });
	}
	const validator = (data: unknown) => {
		if (!data || typeof data !== "object") {
			return validationFailure("Expected object");
		}

		const result: Record<string, unknown> = {};
		const obj_data = data as Record<string, unknown>;

		for (const key in obj_data) {
			if (!keySet.has(key)) {
				result[key] = obj_data[key];
			}
		}

		return result;
	};

	const metadata = jsonSchemaOf(obj);
	if (metadata.properties && typeof metadata.properties === "object" && !Array.isArray(metadata.properties)) {
		const properties = metadata.properties as Record<string, unknown>;
		const filteredProps: Record<string, unknown> = {};
		for (const key in properties) {
			if (!keySet.has(key)) {
				filteredProps[key] = properties[key];
			}
		}
		metadata.properties = filteredProps;
	}
	if (Array.isArray(metadata.required)) {
		metadata.required = metadata.required.filter(key => typeof key === "string" && !keySet.has(key));
	}
	return createArkSchema(validator, metadata);
}

function tComposite(objects: readonly ArkSchema[], opts?: Meta): ArkSchema {
	// Composite flattens object schemas into one
	if (objects.length === 0) {
		return applyMeta(
			createArkSchema(
				(data: unknown) => (data && typeof data === "object" ? data : validationFailure("Expected object")),
				{
					type: "object",
				},
			),
			opts,
		);
	}

	if (objects.length === 1) {
		return applyMeta(objects[0], opts);
	}

	let canFlatten = true;
	const properties: Record<string, ArkSchema> = {};
	for (const schema of objects) {
		if (!schema.__properties) {
			canFlatten = false;
			break;
		}
		for (const key in schema.__properties) {
			properties[key] = schema.__properties[key];
		}
	}
	if (canFlatten) return tObject(properties, opts as ObjectOpts | undefined);

	// Merge all object validators
	const validator = (data: unknown) => {
		if (!data || typeof data !== "object") {
			return validationFailure("Expected object");
		}

		const result = {} as Record<string, unknown>;
		const obj_data = data as Record<string, unknown>;

		for (const schema of objects) {
			const schemaValidator = schema.__validator;
			const schemaResult = schemaValidator(obj_data);

			if (isValidationFailure(schemaResult)) {
				return schemaResult;
			}

			if (typeof schemaResult === "object" && schemaResult !== null) {
				for (const key in schemaResult) {
					result[key] = (schemaResult as Record<string, unknown>)[key];
				}
			}
		}

		return result;
	};

	return applyMeta(createArkSchema(validator, { allOf: objects.map(jsonSchemaOf) }), opts);
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
