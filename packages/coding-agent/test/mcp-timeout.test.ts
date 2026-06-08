import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { logger } from "@oh-my-pi/pi-utils";

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

	test("rejects negative env values and warns, falling back to the default", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "-1";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("OMP_MCP_TIMEOUT_MS");
		} finally {
			warn.mockRestore();
		}
	});

	test("rejects non-numeric env values and falls back to the default", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "not-a-number";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs()).toBe(30_000);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});
