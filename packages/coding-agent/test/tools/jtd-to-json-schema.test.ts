import { describe, expect, it } from "bun:test";
import { jtdToJsonSchema } from "@oh-my-pi/pi-coding-agent/tools/jtd-to-json-schema";

describe("jtdToJsonSchema", () => {
	it("converts JTD elements and int32 primitives into JSON Schema", () => {
		const converted = jtdToJsonSchema({
			properties: {
				results: {
					elements: {
						properties: {
							issue: { type: "int32" },
						},
					},
				},
			},
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							issue: { type: "integer" },
						},
						required: ["issue"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
			additionalProperties: false,
		});
	});

	it("normalizes nested JTD fragments inside JSON Schema nodes", () => {
		const converted = jtdToJsonSchema({
			type: "object",
			properties: {
				results: {
					type: "array",
					elements: {
						properties: {
							issue: { type: "int32" },
						},
					},
				},
			},
			required: ["results"],
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							issue: { type: "integer" },
						},
						required: ["issue"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
		});
	});
	it("does not misinterpret user-named properties that collide with JTD keywords (#1345)", () => {
		// Mirrors the `files[]` shape declared by the built-in explore agent:
		// a JTD elements form whose item properties include one literally named `ref`.
		const converted = jtdToJsonSchema({
			properties: {
				files: {
					elements: {
						properties: {
							ref: { type: "string" },
							description: { type: "string" },
						},
					},
				},
			},
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				files: {
					type: "array",
					items: {
						type: "object",
						properties: {
							ref: { type: "string" },
							description: { type: "string" },
						},
						required: ["ref", "description"],
						additionalProperties: false,
					},
				},
			},
			required: ["files"],
			additionalProperties: false,
		});
	});
});
