import { describe, expect, it } from "vitest";

describe("test environment", () => {
	it("scrubs provider credentials unless live E2E is explicitly enabled", () => {
		if (process.env.LIVE_E2E === "1") return;
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
	});
});
