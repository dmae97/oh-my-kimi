/**
 * Minimal `@sinclair/typebox` runtime compatibility shim, backed by Zod.
 *
 * Historically the coding agent injected the real `@sinclair/typebox` (~5MB
 * dependency) into extensions, hooks, custom tools, and custom commands so
 * they could author parameter schemas as `Type.Object({ name: Type.String() })`.
 * Internally everything already runs through Zod (`wire.ts`, `validation.ts`);
 * the only reason TypeBox remained was extension-author compat.
 *
 * This module replaces that injection with a tiny façade whose `Type` builders
 * return Zod schemas. Output is indistinguishable from hand-written Zod inside
 * the agent pipeline:
 *
 *   - `isZodSchema()` keys off the Zod `_zod` marker that every schema carries.
 *   - `zodToWireSchema()` emits the same draft 2020-12 JSON Schema providers expect
 *     from TypeBox-authored tools (defaulted fields treated as optional, etc.).
 *
 * The surface intentionally covers only the common TypeBox builders. Plugins
 * that reached for niche TypeBox-only APIs (`TypeCompiler`, the global
 * `TypeRegistry`, custom `Symbol(TypeBox.Kind)` introspection) must vendor
 * `@sinclair/typebox` directly in their own package.
 */

import { areJsonValuesEqual, zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	type ZodArray,
	type ZodEnum,
	type ZodObject,
	type ZodOptional,
	type ZodRawShape,
	type ZodType,
	z,
} from "zod/v4";

// ---------------------------------------------------------------------------
// Type aliases — exported so `import type { Static, TSchema } from "..."`
// patterns keep compiling at the call site.
// ---------------------------------------------------------------------------

export type TSchema = ZodType;
export type Static<T extends ZodType> = z.infer<T>;
export type TAny = ZodType;
export type TUnknown = ZodType;
export type TNever = ZodType;
export type TNull = ZodType;
export type TString = z.ZodString;
export type TNumber = z.ZodNumber;
export type TInteger = z.ZodNumber;
export type TBoolean = z.ZodBoolean;
export type TLiteral<V extends string | number | boolean> = z.ZodLiteral<V>;
export type TArray<E extends ZodType> = ZodArray<E>;
export type TObject<P extends ZodRawShape = ZodRawShape> = ZodObject<P>;
export type TOptional<E extends ZodType> = ZodOptional<E>;
export type TUnion<_T extends readonly ZodType[] = readonly ZodType[]> = ZodType;
export type TEnum<T extends readonly (string | number)[] = readonly (string | number)[]> = ZodEnum<{
	[K in T[number] as `${K}`]: K;
}>;
export type TRecord<_K extends ZodType, _V extends ZodType> = ZodType;

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
	additionalProperties?: boolean | ZodType;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stamp a non-enumerable `toJSON()` on a schema so `JSON.stringify(schema)`
 * yields a clean draft 2020-12 JSON Schema — matching real TypeBox semantics
 * where the schema object IS already a JSON Schema. Without this, an extension
 * author who serialises the schema across any JSON boundary (worker
 * postMessage, MCP transport, config persistence, network hop, structuredClone
 * fallback) ships the raw Zod internals (`def`, `_zod`, object-shaped `enum`,
 * `"type":"enum"`) — neither valid JSON Schema nor parseable Zod. See
 * issue #1101 for the symptoms when this leaks into a tool's `input_schema`.
 *
 * Idempotent: re-stamping the same instance is a no-op.
 */
function wire<T extends ZodType>(schema: T): T {
	if (!Object.hasOwn(schema as object, "toJSON")) {
		Object.defineProperty(schema as object, "toJSON", {
			value: function toJSON(this: ZodType) {
				return zodToWireSchema(this);
			},
			enumerable: false,
			writable: true,
			configurable: true,
		});
	}
	return schema;
}

function withMeta<T extends ZodType>(schema: T, opts: Meta | undefined): T {
	let out: ZodType = schema;
	if (opts) {
		if (typeof opts.description === "string") out = out.describe(opts.description);
		if ("default" in opts) out = out.default(opts.default as never) as unknown as ZodType;

		const metadata: Record<string, unknown> = {};
		for (const key in opts) {
			if (key === "description" || key === "default" || key === "additionalProperties") continue;
			metadata[key] = opts[key];
		}
		if (Object.keys(metadata).length > 0) out = out.meta(metadata);
	}
	return wire(out as T);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function tString(opts?: StringOpts): ZodType {
	let s: ZodType = z.string();
	if (opts) {
		// Format selection swaps the base schema for a more specific Zod string
		// validator that emits the right `format` keyword in JSON Schema.
		switch (opts.format) {
			case "email":
				s = z.email();
				break;
			case "url":
			case "uri":
				s = z.url();
				break;
			case "uuid":
				s = z.uuid();
				break;
			case "date-time":
				s = z.iso.datetime();
				break;
			case "date":
				s = z.iso.date();
				break;
			case "time":
				s = z.iso.time();
				break;
			case "ipv4":
				s = z.ipv4();
				break;
			case "ipv6":
				s = z.ipv6();
				break;
			default:
				break;
		}
		// Length/pattern constraints live on the `_ZodString` base that every
		// format-specific schema (ZodEmail, ZodURL, ZodISODateTime, ...) extends,
		// so we apply them regardless of which concrete subclass `s` ended up as.
		const sf = s as z.ZodString;
		if (typeof opts.minLength === "number") s = sf.min(opts.minLength);
		if (typeof opts.maxLength === "number") s = (s as z.ZodString).max(opts.maxLength);
		if (typeof opts.pattern === "string") s = (s as z.ZodString).regex(new RegExp(opts.pattern));
	}
	return withMeta(s, opts);
}

function applyNumberConstraints(base: z.ZodNumber, opts: NumberOpts | undefined): z.ZodNumber {
	if (!opts) return base;
	let out = base;
	if (typeof opts.minimum === "number") out = out.min(opts.minimum);
	if (typeof opts.maximum === "number") out = out.max(opts.maximum);
	if (typeof opts.exclusiveMinimum === "number") out = out.gt(opts.exclusiveMinimum);
	if (typeof opts.exclusiveMaximum === "number") out = out.lt(opts.exclusiveMaximum);
	if (typeof opts.multipleOf === "number") out = out.multipleOf(opts.multipleOf);
	return out;
}

function tNumber(opts?: NumberOpts): ZodType {
	return withMeta(applyNumberConstraints(z.number(), opts), opts);
}

function tInteger(opts?: NumberOpts): ZodType {
	return withMeta(applyNumberConstraints(z.number().int(), opts), opts);
}

function tBoolean(opts?: Meta): ZodType {
	return withMeta(z.boolean(), opts);
}

function tNull(opts?: Meta): ZodType {
	return withMeta(z.null(), opts);
}

function tAny(opts?: Meta): ZodType {
	return withMeta(z.any(), opts);
}

function tUnknown(opts?: Meta): ZodType {
	return withMeta(z.unknown(), opts);
}

function tNever(opts?: Meta): ZodType {
	return withMeta(z.never(), opts);
}

function tLiteral<V extends string | number | boolean>(value: V, opts?: Meta): ZodType {
	return withMeta(z.literal(value), opts);
}

function tUnion<T extends readonly ZodType[]>(schemas: T, opts?: Meta): ZodType {
	if (schemas.length === 0) return withMeta(z.never(), opts);
	if (schemas.length === 1) return withMeta(schemas[0] as ZodType, opts);
	return withMeta(z.union(schemas as unknown as [ZodType, ZodType, ...ZodType[]]), opts);
}

function tIntersect(schemas: readonly ZodType[], opts?: Meta): ZodType {
	if (schemas.length === 0) return withMeta(z.unknown(), opts);
	if (schemas.length === 1) return withMeta(schemas[0] as ZodType, opts);
	let out: ZodType = schemas[0] as ZodType;
	for (let i = 1; i < schemas.length; i++) out = z.intersection(out, schemas[i] as ZodType) as ZodType;
	return withMeta(out, opts);
}

function isArrayIndexKey(key: string): boolean {
	if (!/^(?:0|[1-9]\\d*)$/.test(key)) return false;
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

function literalUnion(values: readonly (string | number | boolean)[], opts?: Meta): ZodType {
	const unique = uniqueLiteralValues(values);
	if (unique.length === 0) return withMeta(z.never(), opts);
	if (unique.length === 1) return withMeta(z.literal(unique[0] as string | number | boolean), opts);
	const schemas = unique.map(value => z.literal(value as string | number | boolean)) as unknown as [
		ZodType,
		ZodType,
		...ZodType[],
	];
	return withMeta(z.union(schemas), opts);
}
function tEnum<T extends Record<string, string | number> | readonly (string | number)[]>(
	values: T,
	opts?: Meta,
): ZodType {
	const list = Array.isArray(values)
		? values
		: Object.entries(values)
				.filter(([key, value]) => !(isArrayIndexKey(key) && typeof value === "string"))
				.map(([, value]) => value);
	return literalUnion(list, opts);
}

function tArray<E extends ZodType>(item: E, opts?: ArrayOpts): ZodType {
	let arr: ZodType = z.array(item);
	if (opts) {
		if (typeof opts.minItems === "number") arr = (arr as ZodArray<E>).min(opts.minItems);
		if (typeof opts.maxItems === "number") arr = (arr as ZodArray<E>).max(opts.maxItems);
		if (opts.uniqueItems === true) {
			arr = arr.refine(items => {
				if (!Array.isArray(items)) return true;
				for (let i = 0; i < items.length; i += 1) {
					for (let j = i + 1; j < items.length; j += 1) {
						if (areJsonValuesEqual(items[i], items[j])) return false;
					}
				}
				return true;
			}, "Expected array items to be unique");
		}
	}
	return withMeta(arr, opts);
}

function tTuple(items: readonly ZodType[], opts?: Meta): ZodType {
	return withMeta(z.tuple(items as unknown as [ZodType, ...ZodType[]]) as unknown as ZodType, opts);
}

function isOptional(schema: ZodType): boolean {
	const def = (schema as { _zod?: { def?: { type?: string } } })._zod?.def;
	return def?.type === "optional";
}

function tObject<P extends ZodRawShape>(properties: P, opts?: ObjectOpts): ZodObject<P> {
	// `z.object` automatically derives `required` from non-optional entries,
	// so `Type.Optional(...)` flows through unchanged (Zod treats `.optional()`
	// and `Type.Optional`-style wrappers identically).
	let obj = z.object(properties);
	const ap = opts?.additionalProperties;
	if (ap === false) {
		obj = obj.strict() as unknown as ZodObject<P>;
	} else if (ap === undefined || ap === true) {
		// TypeBox preserves unknown keys by default; Zod's default is `.strip()`.
		obj = obj.loose() as unknown as ZodObject<P>;
	} else {
		obj = obj.catchall(ap) as unknown as ZodObject<P>;
	}
	return withMeta(obj, opts);
}

function tRecord<V extends ZodType>(key: ZodType, value: V, opts?: Meta): ZodType {
	return withMeta(z.record(key as never, value as never) as unknown as ZodType, opts);
}

function tOptional<E extends ZodType>(schema: E, _opts?: Meta): ZodOptional<E> {
	if (isOptional(schema)) return wire(schema as unknown as ZodOptional<E>);
	return wire(schema.optional() as ZodOptional<E>);
}

function tNullable<E extends ZodType>(schema: E, opts?: Meta): ZodType {
	return withMeta(schema.nullable() as ZodType, opts);
}

function tReadonly<E extends ZodType>(schema: E): E {
	// TypeBox's `Type.Readonly` is purely a marker; runtime parsing is identical.
	return wire(schema);
}

function tPartial<P extends ZodRawShape>(obj: ZodObject<P>): ZodObject<P> {
	return wire(obj.partial() as unknown as ZodObject<P>);
}

function tRequired<P extends ZodRawShape>(obj: ZodObject<P>): ZodObject<P> {
	return wire(obj.required() as unknown as ZodObject<P>);
}

function tPick<P extends ZodRawShape, K extends keyof P>(obj: ZodObject<P>, keys: readonly K[]): ZodObject<Pick<P, K>> {
	const mask = Object.fromEntries(keys.map(k => [k as string, true]));
	return wire(obj.pick(mask as never) as unknown as ZodObject<Pick<P, K>>);
}

function tOmit<P extends ZodRawShape, K extends keyof P>(obj: ZodObject<P>, keys: readonly K[]): ZodObject<Omit<P, K>> {
	const mask = Object.fromEntries(keys.map(k => [k as string, true]));
	return wire(obj.omit(mask as never) as unknown as ZodObject<Omit<P, K>>);
}
function tComposite(objects: readonly ZodObject<ZodRawShape>[], opts?: Meta): ZodObject<ZodRawShape> {
	// `Type.Composite([...])` flattens every object schema into one object schema
	// rather than producing an intersection. Mirror that via repeated `extend`.
	if (objects.length === 0) return withMeta(z.object({}), opts) as ZodObject<ZodRawShape>;
	let out = objects[0] as ZodObject<ZodRawShape>;
	for (let i = 1; i < objects.length; i += 1) {
		out = out.extend(objects[i].shape) as ZodObject<ZodRawShape>;
	}
	return withMeta(out, opts) as ZodObject<ZodRawShape>;
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
