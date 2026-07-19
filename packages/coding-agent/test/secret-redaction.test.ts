import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/core/redaction.ts";

describe("redactSensitiveText", () => {
	it("masks labelled, bearer, and recognizable API-key values", () => {
		const input =
			'Authorization: Bearer synthetic-bearer-value; OPENAI_API_KEY=synthetic-environment-key; https://example.test/callback?api_key=synthetic-api-key&ok=1; {"x-api-key":"synthetic-header-value"}; sk-example-xxxxxxxxxxxxxxxxxxxxxxxx';
		const expected =
			'Authorization: Bearer [REDACTED]; OPENAI_API_KEY=[REDACTED]; https://example.test/callback?api_key=[REDACTED]&ok=1; {"x-api-key":"[REDACTED]"}; [REDACTED]';

		expect(redactSensitiveText(input)).toBe(expected);
		expect(redactSensitiveText(expected)).toBe(expected);
	});

	it("leaves ordinary identifiers and prose unchanged", () => {
		const input =
			"Documentation calls the option api_key; commit=0123456789abcdef0123456789abcdef01234567; build=AbC1234567890DeFghIJK";

		expect(redactSensitiveText(input)).toBe(input);
	});
});
