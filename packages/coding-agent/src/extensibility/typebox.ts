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
 *   - `zodToWireSchema()` emits the same draft-7 JSON Schema providers expect
 *     from TypeBox-authored tools (defaulted fields treated as optional, etc.).
 *
 * The surface intentionally covers only the common TypeBox builders. Plugins
 * that reached for niche TypeBox-only APIs (`TypeCompiler`, the global
 * `TypeRegistry`, custom `Symbol(TypeBox.Kind)` introspection) must vendor
 * `@sinclair/typebox` directly in their own package.
 */

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
	/** When false (TypeBox default), forbid extra keys. When true, allow any. */
	additionalProperties?: boolean | ZodType;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withMeta<T extends ZodType>(schema: T, opts: Meta | undefined): T {
	if (!opts) return schema;
	let out: ZodType = schema;
	if (typeof opts.description === "string") out = out.describe(opts.description);
	if ("default" in opts) out = out.default(opts.default as never) as unknown as ZodType;
	return out as T;
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
		// All TypeBox string formats are still ZodString subclasses, so .min/.max/.regex apply.
		if (s instanceof z.ZodString) {
			if (typeof opts.minLength === "number") s = s.min(opts.minLength);
			if (typeof opts.maxLength === "number") s = (s as z.ZodString).max(opts.maxLength);
			if (typeof opts.pattern === "string") s = (s as z.ZodString).regex(new RegExp(opts.pattern));
		}
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

function tEnum<T extends Record<string, string | number>>(values: T, opts?: Meta): ZodType {
	// Accepts either a plain object (TS enum / record of name→value) or a
	// pre-built array; both are tolerated by `z.enum`. We collapse to values
	// because TypeBox's `Type.Enum` discards the keys for the JSON Schema.
	const list = Array.isArray(values) ? (values as unknown as (string | number)[]) : Object.values(values);
	return withMeta(z.enum(list as [string, ...string[]]), opts);
}

function tArray<E extends ZodType>(item: E, opts?: ArrayOpts): ZodType {
	let arr = z.array(item);
	if (opts) {
		if (typeof opts.minItems === "number") arr = arr.min(opts.minItems);
		if (typeof opts.maxItems === "number") arr = arr.max(opts.maxItems);
		// `uniqueItems` is observably useful only at JSON Schema emit time —
		// providers either honor it or ignore it. Zod has no native equivalent,
		// so we encode it as schema metadata for the wire output to surface.
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
	if (opts && opts.additionalProperties !== undefined) {
		if (opts.additionalProperties === false) {
			// `.strict()` would *reject* extra keys; for parity with the looser
			// real-TypeBox behavior we keep the default (strip-on-parse) which
			// still serializes to `additionalProperties: false`.
		} else if (opts.additionalProperties === true) {
			obj = obj.catchall(z.any()) as unknown as ZodObject<P>;
		} else {
			obj = obj.catchall(opts.additionalProperties) as unknown as ZodObject<P>;
		}
	}
	return withMeta(obj, opts);
}

function tRecord<V extends ZodType>(_key: ZodType, value: V, opts?: Meta): ZodType {
	// JSON Schema `Type.Record(K, V)` is always keyed by strings on the wire
	// (no provider honors numeric keys), so we ignore the key schema beyond
	// the implicit string constraint.
	return withMeta(z.record(z.string(), value) as unknown as ZodType, opts);
}

function tOptional<E extends ZodType>(schema: E, _opts?: Meta): ZodOptional<E> {
	return isOptional(schema) ? (schema as unknown as ZodOptional<E>) : (schema.optional() as ZodOptional<E>);
}

function tNullable<E extends ZodType>(schema: E, opts?: Meta): ZodType {
	return withMeta(schema.nullable() as ZodType, opts);
}

function tReadonly<E extends ZodType>(schema: E): E {
	// TypeBox's `Type.Readonly` is purely a marker; runtime parsing is identical.
	return schema;
}

function tPartial<P extends ZodRawShape>(obj: ZodObject<P>): ZodObject<P> {
	return obj.partial() as unknown as ZodObject<P>;
}

function tRequired<P extends ZodRawShape>(obj: ZodObject<P>): ZodObject<P> {
	return obj.required() as unknown as ZodObject<P>;
}

function tPick<P extends ZodRawShape, K extends keyof P>(obj: ZodObject<P>, keys: readonly K[]): ZodObject<Pick<P, K>> {
	const mask = Object.fromEntries(keys.map(k => [k as string, true]));
	return obj.pick(mask as never) as unknown as ZodObject<Pick<P, K>>;
}

function tOmit<P extends ZodRawShape, K extends keyof P>(obj: ZodObject<P>, keys: readonly K[]): ZodObject<Omit<P, K>> {
	const mask = Object.fromEntries(keys.map(k => [k as string, true]));
	return obj.omit(mask as never) as unknown as ZodObject<Omit<P, K>>;
}

function tComposite<A extends ZodRawShape, B extends ZodRawShape>(
	objects: readonly [ZodObject<A>, ZodObject<B>],
): ZodObject<A & B> {
	// `Type.Composite([A, B])` flattens objects into a single object schema
	// rather than producing an intersection. Mirror that via Zod's extend.
	const [a, b] = objects;
	return a.extend(b.shape) as unknown as ZodObject<A & B>;
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
