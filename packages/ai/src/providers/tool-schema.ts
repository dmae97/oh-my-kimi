import type { Tool } from "../types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Provider APIs validate JSON Schema more strictly than TypeScript callers do.
 * Some tool sources serialize optional/no-argument schemas with `required: null`,
 * but JSON Schema and OpenAI function tools require `required` to be an array when
 * present. Absence already means no required fields, so drop nullish `required`
 * keys while preserving valid arrays and other schema content.
 */
export function normalizeToolParameters(parameters: Tool["parameters"]): Record<string, unknown> {
	const normalize = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			return value.map((item) => normalize(item));
		}
		if (!isRecord(value)) {
			return value;
		}

		const result = Object.create(null) as Record<string, unknown>;
		for (const [key, child] of Object.entries(value)) {
			if (key === "required" && child == null) {
				continue;
			}
			result[key] = normalize(child);
		}
		return result;
	};

	const normalized = normalize(parameters);
	if (isRecord(normalized)) {
		return normalized;
	}
	return { type: "object", properties: {} };
}

function canonicalJsonPart(value: unknown): string | undefined {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJsonPart(item) ?? "null").join(",")}]`;
	}
	if (!isRecord(value)) {
		return undefined;
	}

	const parts: string[] = [];
	for (const key of Object.keys(value).sort()) {
		const child = canonicalJsonPart(value[key]);
		if (child !== undefined) {
			parts.push(`${JSON.stringify(key)}:${child}`);
		}
	}
	return `{${parts.join(",")}}`;
}

export function canonicalJsonStringify(value: unknown): string {
	return canonicalJsonPart(value) ?? "null";
}

export function stableToolSchema(parameters: Tool["parameters"]): Record<string, unknown> {
	const canonical = JSON.parse(canonicalJsonStringify(normalizeToolParameters(parameters))) as unknown;
	if (isRecord(canonical)) {
		return canonical;
	}
	return { type: "object", properties: {} };
}

export function stableTools<TTool extends Tool>(tools: readonly TTool[]): TTool[] {
	return [...tools]
		.map((tool) => {
			const descriptors = Object.getOwnPropertyDescriptors(tool);
			descriptors.parameters = {
				configurable: true,
				enumerable: true,
				value: stableToolSchema(tool.parameters) as TTool["parameters"],
				writable: true,
			};
			return Object.create(Object.getPrototypeOf(tool), descriptors) as TTool;
		})
		.sort(compareStableTools);
}

function compareStableTools(left: Tool, right: Tool): number {
	const nameOrder = left.name.localeCompare(right.name);
	if (nameOrder !== 0) return nameOrder;
	const descriptionOrder = left.description.localeCompare(right.description);
	if (descriptionOrder !== 0) return descriptionOrder;
	return canonicalJsonStringify(left.parameters).localeCompare(canonicalJsonStringify(right.parameters));
}
