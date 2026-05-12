import { describe, expect, it } from "bun:test";
import { sanitizeSchemaForGoogle } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * Problematic JSON Schema features that cause issues with various providers.
 *
 * These are checked AFTER sanitization (sanitizeSchemaForGoogle) is applied,
 * so features like `const` that are transformed by sanitization are not flagged.
 *
 * Prohibited (error):
 * - $schema: Explicit schema declarations
 * - $ref / $defs: Schema references (must inline everything)
 * - prefixItems: Draft 2020-12 feature (use items array)
 * - $dynamicRef / $dynamicAnchor: Draft 2020-12 features
 * - unevaluatedProperties / unevaluatedItems: Draft 2020-12 features
 * - const: Should be converted to enum by sanitization
 * - examples: Should be stripped
 *
 * Warnings (non-blocking):
 * - additionalProperties: false - Sometimes causes validation issues
 * - format: Some validators don't recognize format keywords
 */

const PROHIBITED_KEYS = new Set([
	"$schema",
	"$ref",
	"$defs",
	"$dynamicRef",
	"$dynamicAnchor",
	"prefixItems",
	"unevaluatedProperties",
	"unevaluatedItems",
	"const", // Should be converted to enum by sanitizeSchemaForGoogle
	"examples",
]);

const WARNING_KEYS = new Set(["additionalProperties", "format"]);

interface SchemaViolation {
	path: string;
	key: string;
	value: unknown;
	severity: "error" | "warning";
}

function validateSchema(schema: unknown, path = "root"): SchemaViolation[] {
	const violations: SchemaViolation[] = [];

	if (schema === null || typeof schema !== "object") {
		return violations;
	}

	if (Array.isArray(schema)) {
		for (let i = 0; i < schema.length; i++) {
			violations.push(...validateSchema(schema[i], `${path}[${i}]`));
		}
		return violations;
	}

	const obj = schema as Record<string, unknown>;

	for (const [key, value] of Object.entries(obj)) {
		const currentPath = `${path}.${key}`;

		if (PROHIBITED_KEYS.has(key)) {
			violations.push({
				path: currentPath,
				key,
				value,
				severity: "error",
			});
		}

		if (WARNING_KEYS.has(key)) {
			// additionalProperties: false is the problematic case
			if (key === "additionalProperties" && value === false) {
				violations.push({
					path: currentPath,
					key,
					value,
					severity: "warning",
				});
			}
			// format is always potentially problematic
			if (key === "format" && typeof value === "string") {
				violations.push({
					path: currentPath,
					key,
					value,
					severity: "warning",
				});
			}
		}

		// Recurse into nested objects
		if (value !== null && typeof value === "object") {
			violations.push(...validateSchema(value, currentPath));
		}
	}

	return violations;
}

function createTestSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("sanitizeSchemaForGoogle", () => {
	it("converts const to enum", () => {
		const schema = { type: "string", const: "active" };
		const sanitized = sanitizeSchemaForGoogle(schema);
		expect(sanitized).toEqual({ type: "string", enum: ["active"] });
	});

	it("merges const into existing enum", () => {
		const schema = { type: "string", const: "active", enum: ["inactive"] };
		const sanitized = sanitizeSchemaForGoogle(schema);
		expect(sanitized).toEqual({ type: "string", enum: ["inactive", "active"] });
	});

	it("does not duplicate const in enum", () => {
		const schema = { type: "string", const: "active", enum: ["active", "inactive"] };
		const sanitized = sanitizeSchemaForGoogle(schema);
		expect(sanitized).toEqual({ type: "string", enum: ["active", "inactive"] });
	});

	it("collapses anyOf with const values into enum", () => {
		const schema = {
			anyOf: [
				{ type: "string", const: "file" },
				{ type: "string", const: "dir" },
			],
		};
		const sanitized = sanitizeSchemaForGoogle(schema);
		// anyOf with all const values should collapse into a single enum
		expect(sanitized).toEqual({
			type: "string",
			enum: ["file", "dir"],
		});
	});

	it("handles deeply nested schemas", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: {
						status: { type: "string", const: "active" },
					},
				},
			},
		};
		const sanitized = sanitizeSchemaForGoogle(schema) as Record<string, unknown>;
		const props = sanitized.properties as Record<string, unknown>;
		const nested = props.nested as Record<string, unknown>;
		const nestedProps = nested.properties as Record<string, unknown>;
		const status = nestedProps.status as Record<string, unknown>;
		expect(status.const).toBeUndefined();
		expect(status.enum).toEqual(["active"]);
	});

	it("preserves other schema properties", () => {
		const schema = {
			type: "string",
			const: "value",
			description: "A description",
			minLength: 1,
		};
		const sanitized = sanitizeSchemaForGoogle(schema);
		expect(sanitized).toEqual({
			type: "string",
			enum: ["value"],
			description: "A description",
		});
	});

	it("handles arrays correctly", () => {
		const schema = {
			type: "array",
			items: { type: "string", const: "only" },
		};
		const sanitized = sanitizeSchemaForGoogle(schema) as Record<string, unknown>;
		const items = sanitized.items as Record<string, unknown>;
		expect(items.const).toBeUndefined();
		expect(items.enum).toEqual(["only"]);
	});

	it("passes through primitives unchanged", () => {
		expect(sanitizeSchemaForGoogle("string")).toBe("string");
		expect(sanitizeSchemaForGoogle(123)).toBe(123);
		expect(sanitizeSchemaForGoogle(true)).toBe(true);
		expect(sanitizeSchemaForGoogle(null)).toBe(null);
	});

	it("preserves property names that match schema keywords (e.g., 'pattern')", () => {
		const schema = {
			type: "object",
			properties: {
				pattern: { type: "string", description: "The search pattern" },
				format: { type: "string", description: "Output format" },
			},
			required: ["pattern"],
		};
		const sanitized = sanitizeSchemaForGoogle(schema) as Record<string, unknown>;
		const props = sanitized.properties as Record<string, unknown>;
		expect(props.pattern).toEqual({ type: "string", description: "The search pattern" });
		expect(props.format).toEqual({ type: "string", description: "Output format" });
		expect(sanitized.required).toEqual(["pattern"]);
	});

	it("still strips schema keywords from non-properties contexts", () => {
		const schema = {
			type: "string",
			pattern: "^[a-z]+$",
			format: "email",
			minLength: 1,
		};
		const sanitized = sanitizeSchemaForGoogle(schema) as Record<string, unknown>;
		expect(sanitized.pattern).toBeUndefined();
		expect(sanitized.format).toBeUndefined();
		expect(sanitized.minLength).toBeUndefined();
		expect(sanitized.type).toBe("string");
	});
});

describe("tool schema validation (post-sanitization)", () => {
	it("all builtin tool schemas are valid after sanitization", async () => {
		const session = createTestSession();
		const tools = await createTools(session);

		const allViolations: { tool: string; violations: SchemaViolation[] }[] = [];

		for (const tool of tools) {
			const schema = tool.parameters;
			if (!schema) continue;

			// Apply the same sanitization that happens before sending to providers
			const sanitized = sanitizeSchemaForGoogle(schema);
			const violations = validateSchema(sanitized, tool.name);
			const errors = violations.filter(v => v.severity === "error");

			if (errors.length > 0) {
				allViolations.push({ tool: tool.name, violations: errors });
			}
		}

		if (allViolations.length > 0) {
			const message = allViolations
				.map(({ tool, violations }) => {
					const details = violations.map(v => `  - ${v.path}: ${v.key} = ${JSON.stringify(v.value)}`).join("\n");
					return `${tool}:\n${details}`;
				})
				.join("\n\n");

			throw new Error(`Prohibited JSON Schema features found after sanitization:\n\n${message}`);
		}

		expect(allViolations).toEqual([]);
	});

	it("hidden tools also have valid sanitized schemas", async () => {
		const session = createTestSession();

		for (const [name, factory] of Object.entries(HIDDEN_TOOLS)) {
			const tool = await factory(session);
			if (!tool) continue;

			const schema = tool.parameters;
			if (!schema) continue;

			const sanitized = sanitizeSchemaForGoogle(schema);
			const violations = validateSchema(sanitized, name);
			const errors = violations.filter(v => v.severity === "error");

			if (errors.length > 0) {
				const details = errors.map(v => `  - ${v.path}: ${v.key} = ${JSON.stringify(v.value)}`).join("\n");
				throw new Error(`Hidden tool ${name} has prohibited schema features after sanitization:\n${details}`);
			}
		}
	});
});

describe("validateSchema helper", () => {
	it("detects $schema declarations", () => {
		const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object" };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "$schema")).toBe(true);
	});

	it("detects $ref usage", () => {
		const schema = { type: "object", properties: { foo: { $ref: "#/$defs/Foo" } } };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "$ref")).toBe(true);
	});

	it("detects $defs usage", () => {
		const schema = { $defs: { Foo: { type: "string" } }, type: "object" };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "$defs")).toBe(true);
	});

	it("detects const usage (should be sanitized away)", () => {
		const schema = { type: "object", properties: { status: { const: "active" } } };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "const")).toBe(true);
	});

	it("detects examples field", () => {
		const schema = { type: "string", examples: ["foo", "bar"] };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "examples")).toBe(true);
	});

	it("detects prefixItems (Draft 2020-12)", () => {
		const schema = { type: "array", prefixItems: [{ type: "string" }] };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "prefixItems")).toBe(true);
	});

	it("detects unevaluatedProperties (Draft 2020-12)", () => {
		const schema = { type: "object", unevaluatedProperties: false };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "unevaluatedProperties")).toBe(true);
	});

	it("warns on additionalProperties: false", () => {
		const schema = { type: "object", additionalProperties: false };
		const violations = validateSchema(schema);
		const warning = violations.find(v => v.key === "additionalProperties");
		expect(warning?.severity).toBe("warning");
	});

	it("warns on format keyword", () => {
		const schema = { type: "string", format: "uri" };
		const violations = validateSchema(schema);
		const warning = violations.find(v => v.key === "format");
		expect(warning?.severity).toBe("warning");
	});

	it("recursively validates nested schemas", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: {
						deep: { $ref: "#/$defs/Deep" },
					},
				},
			},
		};
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "$ref")).toBe(true);
		expect(violations.find(v => v.key === "$ref")?.path).toContain("nested");
	});

	it("validates array items", () => {
		const schema = {
			type: "array",
			items: [{ const: "first" }, { type: "string" }],
		};
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "const")).toBe(true);
	});
});
