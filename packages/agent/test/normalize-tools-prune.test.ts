import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { type } from "arktype";

const toolSchema = type({
	path: type("string").describe("where to read"),
	nested: type({ inner: type("string").describe("inner value") }).describe("a nested object"),
});

function makeTool(): AgentTool<typeof toolSchema, { path: string }> {
	return {
		name: "demo",
		label: "Demo",
		description: "top-level tool description",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

/** Read the `properties` map off a wire JSON schema with runtime narrowing. */
function wireProps(parameters: unknown): Record<string, unknown> {
	if (!parameters || typeof parameters !== "object" || !("properties" in parameters)) {
		throw new Error("expected a wire schema with properties");
	}
	const properties = parameters.properties;
	if (!properties || typeof properties !== "object") throw new Error("expected a properties object");
	// Narrowed to a non-null object above; wire property maps are plain string-keyed objects.
	const map = properties as Record<string, unknown>;
	return map;
}

function hasField(parameters: unknown, field: string): boolean {
	return field in wireProps(parameters);
}

function fieldDescription(parameters: unknown, field: string): unknown {
	const value = wireProps(parameters)[field];
	if (value && typeof value === "object" && "description" in value) return value.description;
	return undefined;
}

describe("normalizeTools — pruneDescriptions", () => {
	it("keeps the top-level description when pruning is off", () => {
		const tools = normalizeTools([makeTool()], false);
		expect(tools?.[0]?.description).toBe("top-level tool description");
	});

	it("empties the description and strips nested schema descriptions when pruning", () => {
		const tools = normalizeTools([makeTool()], false, undefined, true);
		const tool = tools?.[0];
		expect(tool?.description).toBe("");
		const wire = JSON.stringify(tool?.parameters);
		expect(wire).not.toContain("where to read");
		expect(wire).not.toContain("inner value");
		expect(wire).not.toContain("a nested object");
		// Structure is preserved.
		expect(hasField(tool?.parameters, "path")).toBe(true);
		expect(hasField(tool?.parameters, "nested")).toBe(true);
	});

	it("injects the intent field WITHOUT a description when pruning", () => {
		const tools = normalizeTools([makeTool()], true, undefined, true);
		const params = tools?.[0]?.parameters;
		expect(hasField(params, INTENT_FIELD)).toBe(true);
		expect(fieldDescription(params, INTENT_FIELD)).toBeUndefined();
		// No description text rides the wire at all.
		expect(JSON.stringify(params)).not.toContain("description");
	});

	it("keeps the intent field description when not pruning", () => {
		const tools = normalizeTools([makeTool()], true);
		expect(typeof fieldDescription(tools?.[0]?.parameters, INTENT_FIELD)).toBe("string");
	});
});
