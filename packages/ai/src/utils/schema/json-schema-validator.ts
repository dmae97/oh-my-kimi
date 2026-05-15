import { areJsonValuesEqual } from "./equality";

export interface JsonSchemaValidationIssue {
	path: PropertyKey[];
	message: string;
	expectedTypes?: string[];
	keyword?: string;
}

export interface JsonSchemaValidationResult {
	success: boolean;
	issues: JsonSchemaValidationIssue[];
}

interface ValidationContext {
	root: unknown;
	seenRefs: Set<string>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushIssue(
	issues: JsonSchemaValidationIssue[],
	path: readonly PropertyKey[],
	message: string,
	options: { expectedTypes?: string[]; keyword?: string } = {},
): void {
	issues.push({ path: [...path], message, ...options });
}

function typeOfJsonValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && Number.isInteger(value)) return "integer";
	return typeof value;
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return isJsonObject(value);
		case "array":
			return Array.isArray(value);
		case "null":
			return value === null;
		default:
			return false;
	}
}

function schemaTypes(schema: Record<string, unknown>): string[] {
	const raw = schema.type;
	const types =
		typeof raw === "string"
			? [raw]
			: Array.isArray(raw)
				? raw.filter((entry): entry is string => typeof entry === "string")
				: [];
	if (schema.nullable === true && !types.includes("null")) {
		return [...types, "null"];
	}
	return types;
}

function decodePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(root: unknown, ref: string): unknown | undefined {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const rawToken of ref.slice(2).split("/")) {
		const token = decodePointerToken(rawToken);
		if (!isJsonObject(current) && !Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[token];
	}
	return current;
}

function isRequiredSet(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function validateSchemaNode(
	schema: unknown,
	value: unknown,
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	if (schema === true) return true;
	if (schema === false) {
		pushIssue(issues, path, "must not match false schema", { keyword: "false" });
		return false;
	}
	if (!isJsonObject(schema)) {
		pushIssue(issues, path, "schema must be an object or boolean", { keyword: "schema" });
		return false;
	}

	const ref = schema.$ref;
	if (typeof ref === "string") {
		if (ctx.seenRefs.has(ref)) return true;
		const resolved = resolveLocalRef(ctx.root, ref);
		if (resolved === undefined) {
			pushIssue(issues, path, `unresolved reference ${ref}`, { keyword: "$ref" });
			return false;
		}
		ctx.seenRefs.add(ref);
		const ok = validateSchemaNode(resolved, value, path, ctx, issues);
		ctx.seenRefs.delete(ref);
		return ok;
	}

	if (value === null && schema.nullable === true) return true;

	let valid = true;
	const types = schemaTypes(schema);
	if (types.length > 0 && !types.some(type => matchesJsonSchemaType(value, type))) {
		pushIssue(issues, path, `expected ${types.join(" or ")}, received ${typeOfJsonValue(value)}`, {
			keyword: "type",
			expectedTypes: types,
		});
		return false;
	}

	if ("const" in schema && !areJsonValuesEqual(value, schema.const)) {
		pushIssue(issues, path, "must equal const value", { keyword: "const" });
		valid = false;
	}

	if (Array.isArray(schema.enum) && !schema.enum.some(entry => areJsonValuesEqual(entry, value))) {
		pushIssue(issues, path, "must be one of the allowed enum values", { keyword: "enum" });
		valid = false;
	}

	for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		if (keyword === "allOf") {
			for (const branch of branches) {
				valid = validateSchemaNode(branch, value, path, ctx, issues) && valid;
			}
			continue;
		}

		let matches = 0;
		let firstIssues: JsonSchemaValidationIssue[] | undefined;
		for (const branch of branches) {
			const branchIssues: JsonSchemaValidationIssue[] = [];
			if (validateSchemaNode(branch, value, path, ctx, branchIssues)) {
				matches += 1;
			} else if (!firstIssues) {
				firstIssues = branchIssues;
			}
		}
		const branchValid = keyword === "anyOf" ? matches > 0 : matches === 1;
		if (!branchValid) {
			if (matches === 0 && firstIssues && firstIssues.length > 0) {
				issues.push(...firstIssues);
			} else {
				pushIssue(
					issues,
					path,
					keyword === "anyOf" ? "must match at least one schema" : "must match exactly one schema",
					{
						keyword,
					},
				);
			}
			valid = false;
		}
	}

	if ("not" in schema) {
		const notIssues: JsonSchemaValidationIssue[] = [];
		if (validateSchemaNode(schema.not, value, path, ctx, notIssues)) {
			pushIssue(issues, path, "must not match excluded schema", { keyword: "not" });
			valid = false;
		}
	}

	if (isJsonObject(value)) {
		valid = validateObjectKeywords(schema, value, path, ctx, issues) && valid;
	}
	if (Array.isArray(value)) {
		valid = validateArrayKeywords(schema, value, path, ctx, issues) && valid;
	}
	if (typeof value === "string") {
		valid = validateStringKeywords(schema, value, path, issues) && valid;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		valid = validateNumberKeywords(schema, value, path, issues) && valid;
	}

	return valid;
}

function validateObjectKeywords(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	const properties = isJsonObject(schema.properties) ? schema.properties : {};
	if (isRequiredSet(schema.required)) {
		for (const key of schema.required) {
			if (!(key in value)) {
				pushIssue(issues, [...path, key], "is required", { keyword: "required" });
				valid = false;
			}
		}
	}

	for (const [key, propertySchema] of Object.entries(properties)) {
		if (!(key in value)) continue;
		valid = validateSchemaNode(propertySchema, value[key], [...path, key], ctx, issues) && valid;
	}

	if (schema.propertyNames !== undefined) {
		for (const key of Object.keys(value)) {
			valid = validateSchemaNode(schema.propertyNames, key, [...path, key], ctx, issues) && valid;
		}
	}

	const known = new Set(Object.keys(properties));
	const additional = schema.additionalProperties;
	if (additional === false) {
		for (const key of Object.keys(value)) {
			if (known.has(key)) continue;
			pushIssue(issues, [...path, key], "must not be present", { keyword: "additionalProperties" });
			valid = false;
		}
	} else if (additional !== undefined && additional !== true) {
		for (const [key, entry] of Object.entries(value)) {
			if (known.has(key)) continue;
			valid = validateSchemaNode(additional, entry, [...path, key], ctx, issues) && valid;
		}
	}

	if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
		pushIssue(issues, path, `must have at least ${schema.minProperties} properties`, { keyword: "minProperties" });
		valid = false;
	}
	if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
		pushIssue(issues, path, `must have at most ${schema.maxProperties} properties`, { keyword: "maxProperties" });
		valid = false;
	}

	return valid;
}

function validateArrayKeywords(
	schema: Record<string, unknown>,
	value: unknown[],
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minItems === "number" && value.length < schema.minItems) {
		pushIssue(issues, path, `must have at least ${schema.minItems} items`, { keyword: "minItems" });
		valid = false;
	}
	if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
		pushIssue(issues, path, `must have at most ${schema.maxItems} items`, { keyword: "maxItems" });
		valid = false;
	}
	if (schema.uniqueItems === true) {
		for (let i = 0; i < value.length; i += 1) {
			for (let j = i + 1; j < value.length; j += 1) {
				if (!areJsonValuesEqual(value[i], value[j])) continue;
				pushIssue(issues, [...path, j], "must be unique", { keyword: "uniqueItems" });
				valid = false;
			}
		}
	}

	const items = schema.items;
	if (Array.isArray(items)) {
		const limit = Math.min(items.length, value.length);
		for (let i = 0; i < limit; i += 1) {
			valid = validateSchemaNode(items[i], value[i], [...path, i], ctx, issues) && valid;
		}
		if (schema.additionalItems === false && value.length > items.length) {
			for (let i = items.length; i < value.length; i += 1) {
				pushIssue(issues, [...path, i], "must not be present", { keyword: "additionalItems" });
				valid = false;
			}
		} else if (schema.additionalItems !== undefined && schema.additionalItems !== true) {
			for (let i = items.length; i < value.length; i += 1) {
				valid = validateSchemaNode(schema.additionalItems, value[i], [...path, i], ctx, issues) && valid;
			}
		}
	} else if (items !== undefined) {
		for (let i = 0; i < value.length; i += 1) {
			valid = validateSchemaNode(items, value[i], [...path, i], ctx, issues) && valid;
		}
	}

	return valid;
}

function validateStringKeywords(
	schema: Record<string, unknown>,
	value: string,
	path: readonly PropertyKey[],
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minLength === "number" && value.length < schema.minLength) {
		pushIssue(issues, path, `must be at least ${schema.minLength} characters`, { keyword: "minLength" });
		valid = false;
	}
	if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
		pushIssue(issues, path, `must be at most ${schema.maxLength} characters`, { keyword: "maxLength" });
		valid = false;
	}
	if (typeof schema.pattern === "string") {
		try {
			if (!new RegExp(schema.pattern).test(value)) {
				pushIssue(issues, path, "must match pattern", { keyword: "pattern" });
				valid = false;
			}
		} catch {
			pushIssue(issues, path, "schema pattern is invalid", { keyword: "pattern" });
			valid = false;
		}
	}
	return valid;
}

function validateNumberKeywords(
	schema: Record<string, unknown>,
	value: number,
	path: readonly PropertyKey[],
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minimum === "number" && value < schema.minimum) {
		pushIssue(issues, path, `must be >= ${schema.minimum}`, { keyword: "minimum" });
		valid = false;
	}
	if (typeof schema.maximum === "number" && value > schema.maximum) {
		pushIssue(issues, path, `must be <= ${schema.maximum}`, { keyword: "maximum" });
		valid = false;
	}
	if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
		pushIssue(issues, path, `must be > ${schema.exclusiveMinimum}`, { keyword: "exclusiveMinimum" });
		valid = false;
	}
	if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
		pushIssue(issues, path, `must be < ${schema.exclusiveMaximum}`, { keyword: "exclusiveMaximum" });
		valid = false;
	}
	if (schema.exclusiveMinimum === true && typeof schema.minimum === "number" && value <= schema.minimum) {
		pushIssue(issues, path, `must be > ${schema.minimum}`, { keyword: "exclusiveMinimum" });
		valid = false;
	}
	if (schema.exclusiveMaximum === true && typeof schema.maximum === "number" && value >= schema.maximum) {
		pushIssue(issues, path, `must be < ${schema.maximum}`, { keyword: "exclusiveMaximum" });
		valid = false;
	}
	if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
		const quotient = value / schema.multipleOf;
		if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 10) {
			pushIssue(issues, path, `must be a multiple of ${schema.multipleOf}`, { keyword: "multipleOf" });
			valid = false;
		}
	}
	return valid;
}

export function validateJsonSchemaValue(schema: unknown, value: unknown): JsonSchemaValidationResult {
	const issues: JsonSchemaValidationIssue[] = [];
	const success = validateSchemaNode(schema, value, [], { root: schema, seenRefs: new Set() }, issues);
	return { success, issues };
}

export function isJsonSchemaValueValid(schema: unknown, value: unknown): boolean {
	return validateJsonSchemaValue(schema, value).success;
}
