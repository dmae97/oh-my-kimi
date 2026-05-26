import { afterEach, describe, expect, test } from "bun:test";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../src/mcp/timeout";

const ORIGINAL_TIMEOUT = process.env.OMP_MCP_TIMEOUT_MS;

afterEach(() => {
	if (ORIGINAL_TIMEOUT === undefined) {
		delete process.env.OMP_MCP_TIMEOUT_MS;
	} else {
		process.env.OMP_MCP_TIMEOUT_MS = ORIGINAL_TIMEOUT;
	}
});

describe("MCP timeout configuration", () => {
	test("uses the default timeout when no config or env override is set", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs()).toBe(30_000);
	});

	test("uses per-server timeout when env override is unset", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
	});

	test("allows the env override to disable MCP client-side timeouts", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "0";

		const timeout = resolveMCPTimeoutMs(30_000);
		expect(timeout).toBe(0);
		expect(isMCPTimeoutEnabled(timeout)).toBe(false);
	});

	test("allows the env override to set one timeout for every server", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "180000";

		expect(resolveMCPTimeoutMs(30_000)).toBe(180_000);
	});
});
