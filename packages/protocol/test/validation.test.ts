import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseTaskSpec } from "../src/index.ts";

describe("parseTaskSpec", () => {
	const valid = {
		schemaVersion: PROTOCOL_VERSION,
		taskId: "task-1",
		goal: "Verify a release",
		createdAt: "2026-08-16T00:00:00.000Z",
		claims: [
			{
				claimId: "build",
				statement: "The build succeeds",
				requirement: "required",
				condition: {
					kind: "observation",
					observationKind: "build",
					scope: "attempt",
					facts: { exitCode: 0 },
				},
			},
		],
	};

	it("accepts the v1 contract", () => {
		expect(parseTaskSpec(valid)).toEqual(valid);
	});

	it("rejects unsupported versions and duplicate claim ids", () => {
		expect(() => parseTaskSpec({ ...valid, schemaVersion: "omk.run.v2" })).toThrow(/schemaVersion/);
		expect(() => parseTaskSpec({ ...valid, claims: [valid.claims[0], valid.claims[0]] })).toThrow(
			/duplicate claimId build/,
		);
	});

	it("rejects empty logical conditions", () => {
		expect(() =>
			parseTaskSpec({
				...valid,
				claims: [{ ...valid.claims[0], condition: { kind: "all", conditions: [] } }],
			}),
		).toThrow(/conditions.*non-empty/);
	});
});
