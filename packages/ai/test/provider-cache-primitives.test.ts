import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	clampOpenAIPromptCacheKey,
	derivePromptCacheKey,
	OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
	resolveOpenAIPromptCacheKey,
} from "../src/providers/openai-prompt-cache.ts";
import { convertResponsesTools } from "../src/providers/openai-responses-shared.ts";
import {
	canonicalJsonStringify,
	normalizeToolParameters,
	stableToolSchema,
	stableTools,
} from "../src/providers/tool-schema.ts";
import type { Tool } from "../src/types.ts";

describe("provider cache primitives", () => {
	it("canonicalJsonStringify sorts object keys deterministically at every depth", () => {
		const first = {
			z: 3,
			"2": "two",
			a: { y: 2, x: 1 },
			"10": "ten",
			b: [{ d: 4, c: 3 }],
		};
		const second = {
			b: [{ c: 3, d: 4 }],
			"10": "ten",
			a: { x: 1, y: 2 },
			"2": "two",
			z: 3,
		};

		const canonical = '{"10":"ten","2":"two","a":{"x":1,"y":2},"b":[{"c":3,"d":4}],"z":3}';
		expect(canonicalJsonStringify(first)).toBe(canonical);
		expect(canonicalJsonStringify(second)).toBe(canonical);
	});

	it("stableToolSchema preserves normalization while producing canonical schema bytes", () => {
		const first = {
			required: null,
			properties: {
				zeta: { required: null, type: "string" },
				alpha: { type: "string", enum: ["one", "two"] },
			},
			type: "object",
		} as unknown as Tool["parameters"];
		const second = {
			type: "object",
			properties: {
				alpha: { enum: ["one", "two"], type: "string" },
				zeta: { type: "string", required: null },
			},
			required: null,
		} as unknown as Tool["parameters"];

		const schema = stableToolSchema(first);
		const properties = schema.properties as Record<string, unknown>;
		const zeta = properties.zeta as Record<string, unknown>;

		expect(schema.required).toBeUndefined();
		expect(zeta.required).toBeUndefined();
		expect(canonicalJsonStringify(schema)).toBe(canonicalJsonStringify(stableToolSchema(second)));
		expect(canonicalJsonStringify(schema)).toBe(
			'{"properties":{"alpha":{"enum":["one","two"],"type":"string"},"zeta":{"type":"string"}},"type":"object"}',
		);
	});

	it("stableTools sorts by name and canonical schema bytes without mutating the caller array", () => {
		const tools: Tool[] = [
			{
				name: "zeta",
				description: "last",
				parameters: Type.Object({ value: Type.String() }),
			},
			{
				name: "alpha",
				description: "first",
				parameters: {
					required: null,
					type: "object",
					properties: { b: { type: "string" }, a: { type: "number" } },
				} as unknown as Tool["parameters"],
			},
		];

		const sorted = stableTools(tools);

		expect(sorted.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
		expect(tools.map((tool) => tool.name)).toEqual(["zeta", "alpha"]);
		expect(canonicalJsonStringify(sorted[0].parameters)).toBe(
			'{"properties":{"a":{"type":"number"},"b":{"type":"string"}},"type":"object"}',
		);
	});

	it("stableTools does not evaluate runtime-only getters", () => {
		const tool: Tool = {
			name: "lazy-runtime-tool",
			description: "tool with session-bound runtime state",
			parameters: Type.Object({}),
		};
		Object.defineProperty(tool, "timeoutMs", {
			enumerable: true,
			get: () => {
				throw new Error("stale extension context");
			},
		});

		expect(() => stableTools([tool])).not.toThrow();
		const [stable] = stableTools([tool]);
		expect(Object.getOwnPropertyDescriptor(stable, "timeoutMs")?.get).toBeTypeOf("function");
	});

	it("convertResponsesTools uses stable tool order and canonical parameters", () => {
		const tools: Tool[] = [
			{
				name: "zeta",
				description: "last",
				parameters: Type.Object({ ok: Type.Boolean() }),
			},
			{
				name: "alpha",
				description: "first",
				parameters: {
					type: "object",
					required: null,
					properties: { b: { type: "string" }, a: { type: "number" } },
				} as unknown as Tool["parameters"],
			},
		];

		const converted = convertResponsesTools(tools);

		expect(converted.map((tool) => (tool.type === "function" ? tool.name : ""))).toEqual(["alpha", "zeta"]);
		const first = converted[0];
		expect(first.type).toBe("function");
		if (first.type === "function") {
			expect(canonicalJsonStringify(first.parameters)).toBe(
				'{"properties":{"a":{"type":"number"},"b":{"type":"string"}},"type":"object"}',
			);
		}
	});

	it("normalizeToolParameters keeps the no-argument fallback unchanged", () => {
		const normalized = normalizeToolParameters("not-a-schema" as unknown as Tool["parameters"]);

		expect(normalized).toEqual({ type: "object", properties: {} });
	});

	it("preserves prototype pollution keys as schema data", () => {
		const parameters = JSON.parse(
			'{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"}}}',
		) as Tool["parameters"];

		const normalized = normalizeToolParameters(parameters);
		const normalizedProperties = normalized.properties as Record<string, unknown>;

		expect(Object.getOwnPropertyDescriptor(normalizedProperties, "__proto__")).toBeDefined();
		expect((normalizedProperties.__proto__ as Record<string, unknown>).type).toBe("string");
		expect((normalizedProperties.constructor as unknown as Record<string, unknown>).type).toBe("number");

		const stable = stableToolSchema(parameters);
		const stableProperties = stable.properties as Record<string, unknown>;

		expect(Object.getOwnPropertyDescriptor(stableProperties, "__proto__")).toBeDefined();
		expect((stableProperties.__proto__ as Record<string, unknown>).type).toBe("string");
		expect((stableProperties.constructor as unknown as Record<string, unknown>).type).toBe("number");
	});

	it("derivePromptCacheKey is deterministic, bounded, and independent of input property order", () => {
		const first = derivePromptCacheKey({
			workspacePath: "/repo",
			promptVersion: "prompt-v1",
			parentRulesVersion: "parents-v1",
			toolSchemaVersion: "tools-v1",
			sessionId: "session-1",
		});
		const second = derivePromptCacheKey({
			sessionId: "session-1",
			toolSchemaVersion: "tools-v1",
			parentRulesVersion: "parents-v1",
			promptVersion: "prompt-v1",
			workspacePath: "/repo",
		});

		expect(first).toBe(second);
		expect(Array.from(first)).toHaveLength(first.length);
		expect(first.length).toBeLessThanOrEqual(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
	});

	it("derivePromptCacheKey invalidates when cache-affecting versions change", () => {
		const base = {
			workspacePath: "/repo",
			promptVersion: "prompt-v1",
			parentRulesVersion: "parents-v1",
			toolSchemaVersion: "tools-v1",
			sessionId: "session-1",
		};
		const keys = [
			derivePromptCacheKey(base),
			derivePromptCacheKey({ ...base, workspacePath: "/other-repo" }),
			derivePromptCacheKey({ ...base, promptVersion: "prompt-v2" }),
			derivePromptCacheKey({ ...base, parentRulesVersion: "parents-v2" }),
			derivePromptCacheKey({ ...base, toolSchemaVersion: "tools-v2" }),
			derivePromptCacheKey({ ...base, sessionId: "session-2" }),
		];

		expect(new Set(keys).size).toBe(keys.length);
	});

	it("derives cache affinity from the stable prefix and canonical tools", () => {
		const tools: Tool[] = [
			{
				name: "zeta",
				description: "last",
				parameters: Type.Object({ z: Type.String(), a: Type.Number() }),
			},
			{
				name: "alpha",
				description: "first",
				parameters: Type.Object({ value: Type.Boolean() }),
			},
		];
		const prefix = "stable instructions";
		const first = resolveOpenAIPromptCacheKey(
			{
				systemPrompt: `${prefix}\ndynamic one`,
				systemPromptCacheBoundary: prefix.length,
				messages: [],
				tools,
			},
			"session-one",
			"openai/gpt-test",
		);
		const second = resolveOpenAIPromptCacheKey(
			{
				systemPrompt: `${prefix}\ndynamic two`,
				systemPromptCacheBoundary: prefix.length,
				messages: [],
				tools: [...tools].reverse(),
			},
			"session-two",
			"openai/gpt-test",
		);
		const changed = resolveOpenAIPromptCacheKey(
			{
				systemPrompt: `changed instructions\ndynamic two`,
				systemPromptCacheBoundary: "changed instructions".length,
				messages: [],
				tools,
			},
			"session-two",
			"openai/gpt-test",
		);

		expect(first).toBe(second);
		expect(changed).not.toBe(first);
		expect(resolveOpenAIPromptCacheKey({ messages: [] }, "session-fallback", "scope")).toBe("session-fallback");

		const fullyStablePrompt = "fully stable instructions";
		expect(
			resolveOpenAIPromptCacheKey(
				{
					systemPrompt: fullyStablePrompt,
					systemPromptCacheBoundary: fullyStablePrompt.length,
					messages: [],
				},
				"session-fallback",
				"scope",
			),
		).toMatch(/^omk-/);
		expect(
			resolveOpenAIPromptCacheKey(
				{
					systemPrompt: fullyStablePrompt,
					systemPromptCacheBoundary: fullyStablePrompt.length + 1,
					messages: [],
				},
				"session-fallback",
				"scope",
			),
		).toBeUndefined();
		expect(
			resolveOpenAIPromptCacheKey(
				{
					systemPrompt: fullyStablePrompt,
					systemPromptCacheBoundaryBypass: true,
					messages: [],
				},
				"session-fallback",
				"scope",
			),
		).toBeUndefined();
	});

	it("clampOpenAIPromptCacheKey preserves undefined and clamps by Unicode code point", () => {
		const key = `${"a".repeat(63)}🚀suffix`;

		expect(clampOpenAIPromptCacheKey(undefined)).toBeUndefined();
		expect(Array.from(clampOpenAIPromptCacheKey(key) ?? "")).toHaveLength(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
		expect(clampOpenAIPromptCacheKey(key)).toBe(`${"a".repeat(63)}🚀`);
	});
});
