import { describe, expect, it } from "bun:test";
import { shouldSkipHistory } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";

describe("shouldSkipHistory — security filter for slash command history", () => {
	it("skips /login with a redirect URL argument (contains OAuth code/state)", () => {
		expect(shouldSkipHistory("/login http://localhost:1455/auth/callback?code=abc&state=xyz")).toBe(true);
	});

	it("does not skip /login without arguments (triggers provider selector)", () => {
		expect(shouldSkipHistory("/login")).toBe(false);
	});

	it("does not skip /login with a provider name only", () => {
		expect(shouldSkipHistory("/login anthropic")).toBe(false);
	});

	it("skips /mcp add with --token flag (contains bearer token)", () => {
		expect(shouldSkipHistory("/mcp add myserver --url http://x --token sk-secret123")).toBe(true);
	});

	it("does not skip /mcp add without --token", () => {
		expect(shouldSkipHistory("/mcp add myserver --url http://x")).toBe(false);
	});

	it("does not skip /mcp without add subcommand", () => {
		expect(shouldSkipHistory("/mcp list")).toBe(false);
		expect(shouldSkipHistory("/mcp reload")).toBe(false);
	});

	it("does not skip ordinary slash commands", () => {
		expect(shouldSkipHistory("/plan do something")).toBe(false);
		expect(shouldSkipHistory("/settings")).toBe(false);
		expect(shouldSkipHistory("/btw what is this")).toBe(false);
		expect(shouldSkipHistory("/model claude")).toBe(false);
	});

	it("returns false for non-slash text", () => {
		expect(shouldSkipHistory("just a prompt")).toBe(false);
		expect(shouldSkipHistory("")).toBe(false);
	});
});
