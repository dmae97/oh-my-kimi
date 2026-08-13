import { describe, expect, it } from "vitest";
import {
	buildRuntimeProvenance,
	parseRuntimeProvenance,
	RUNTIME_PROVENANCE_SCHEMA_VERSION,
	type RuntimeProvenance,
	type RuntimeProvenanceInput,
} from "../src/core/runtime-provenance.ts";

function base(overrides: Partial<RuntimeProvenanceInput> = {}): RuntimeProvenanceInput {
	return {
		requestedModel: "anthropic/claude-opus-5",
		selectedModel: "anthropic/claude-opus-5",
		responseModel: "anthropic/claude-opus-5",
		requestedThinking: "max",
		effectiveThinking: "max",
		source: "session",
		observedAt: "2026-08-13T05:00:00.000Z",
		...overrides,
	};
}

describe("buildRuntimeProvenance", () => {
	it("builds a versioned, sanitized record", () => {
		const value = buildRuntimeProvenance(base());
		expect(value.schemaVersion).toBe(RUNTIME_PROVENANCE_SCHEMA_VERSION);
		expect(value.requestedModel).toBe("anthropic/claude-opus-5");
		expect(value.selectedModel).toBe("anthropic/claude-opus-5");
		expect(value.responseModel).toBe("anthropic/claude-opus-5");
		expect(value.source).toBe("session");
		expect(Object.isFrozen(value)).toBe(true);
	});

	it("preserves both models when selected and response differ", () => {
		const value = buildRuntimeProvenance(
			base({ selectedModel: "anthropic/claude-opus-5", responseModel: "openai/gpt-5.6-sol" }),
		);
		expect(value.selectedModel).toBe("anthropic/claude-opus-5");
		expect(value.responseModel).toBe("openai/gpt-5.6-sol");
	});

	it("preserves requested auto thinking separately from the resolved level", () => {
		const value = buildRuntimeProvenance(base({ requestedThinking: "auto", effectiveThinking: "xhigh" }));
		expect(value.requestedThinking).toBe("auto");
		expect(value.effectiveThinking).toBe("xhigh");
	});

	it("defaults missing fields to null instead of fabricating provenance", () => {
		const value = buildRuntimeProvenance({});
		expect(value.requestedModel).toBeNull();
		expect(value.selectedModel).toBeNull();
		expect(value.responseModel).toBeNull();
		expect(value.requestedThinking).toBeNull();
		expect(value.effectiveThinking).toBeNull();
		expect(value.source).toBe("session");
		expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.observedAt)).toBe(true);
	});

	it("rejects credential-shaped and malformed fields without throwing", () => {
		for (const bad of [
			"sk-ant-abc123def456ghi789",
			"AKIAIOSFODNN7EXAMPLE",
			"ghp_abcdefghijklmnopqrst",
			"Bearer xyz",
			"a\x00b",
		]) {
			expect(buildRuntimeProvenance(base({ responseModel: bad })).responseModel).toBeNull();
		}
		expect(buildRuntimeProvenance(base({ selectedModel: "x".repeat(200) })).selectedModel).toBeNull();
	});

	it("trims surrounding whitespace", () => {
		expect(buildRuntimeProvenance(base({ requestedModel: "  deepseek/deepseek-v4-pro  " })).requestedModel).toBe(
			"deepseek/deepseek-v4-pro",
		);
	});
});

describe("parseRuntimeProvenance", () => {
	const valid: RuntimeProvenance = buildRuntimeProvenance(base());

	it("round-trips a valid record", () => {
		expect(parseRuntimeProvenance(valid)).toEqual(valid);
	});

	it("returns null, never throws, on any shape violation", () => {
		expect(parseRuntimeProvenance(null)).toBeNull();
		expect(parseRuntimeProvenance("nope")).toBeNull();
		expect(parseRuntimeProvenance([])).toBeNull();
		expect(parseRuntimeProvenance({ ...valid, extra: 1 })).toBeNull();
		expect(parseRuntimeProvenance({ ...valid, schemaVersion: "other" })).toBeNull();
		expect(parseRuntimeProvenance({ ...valid, source: "trust-me" })).toBeNull();
		expect(parseRuntimeProvenance({ ...valid, responseModel: "sk-ant-abc123def456ghi789" })).toBeNull();
	});

	it("re-sanitizes on read, so persisted provider echo cannot smuggle credentials", () => {
		const forged = { ...valid, responseModel: "AKIAIOSFODNN7EXAMPLE" };
		expect(parseRuntimeProvenance(forged)).toBeNull();
	});
});
