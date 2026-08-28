import { describe, expect, it } from "vitest";
import {
	ADAPTORCH_FULL_ONLY_TOOLS,
	ADAPTORCH_REMOTE_TOOLS,
	ADAPTORCH_TOOLS,
	AdaptOrchClient,
	type AdaptOrchTransport,
} from "../src/adaptorch-client.ts";

/**
 * Parity with the server's own tool inventory. The AdaptOrch MCP server splits
 * its surface: `diagnostics.EXPECTED_CORE_TOOLS` is what every deployment
 * exposes, and two more tools exist only in a full/local deployment. Encoding
 * that split here keeps a caller from advertising a tool a remote tenant
 * cannot reach.
 */
describe("AdaptOrch MCP tool surface", () => {
	it("names the nine core tools every deployment exposes", () => {
		expect([...ADAPTORCH_REMOTE_TOOLS]).toEqual([
			"adaptorch_run",
			"adaptorch_get_run",
			"adaptorch_get_artifacts",
			"adaptorch_list_runs",
			"adaptorch_cancel_run",
			"adaptorch_server_metrics",
			"adaptorch_capabilities",
			"adaptorch_usage",
			"adaptorch_plan_catalog",
		]);
	});

	it("keeps trace and topology reads as full-deployment-only", () => {
		expect([...ADAPTORCH_FULL_ONLY_TOOLS]).toEqual(["adaptorch_get_traces", "adaptorch_route_topology"]);
	});

	it("composes the full surface from the two tiers without overlap", () => {
		expect(ADAPTORCH_TOOLS).toEqual([...ADAPTORCH_REMOTE_TOOLS, ...ADAPTORCH_FULL_ONLY_TOOLS]);
		expect(new Set(ADAPTORCH_TOOLS).size).toBe(ADAPTORCH_TOOLS.length);
	});
});

describe("AdaptOrchClient.usage", () => {
	it("reads the tenant's own usage window", async () => {
		let called: string | undefined;
		const transport: AdaptOrchTransport = {
			callTool: async (name) => {
				called = name;
				return { tenant_id: "t1", plan_level: "pro", used: 12, limit: 100, remaining: 88 };
			},
		};

		const result = await new AdaptOrchClient(transport).usage();

		expect(called).toBe("adaptorch_usage");
		expect(result.used).toBe(12);
	});
});

describe("AdaptOrchClient.routeTopology", () => {
	it("reads the current topology response field", async () => {
		const transport: AdaptOrchTransport = {
			callTool: async () => ({ topology: "hybrid", reason: "mixed dependencies" }),
		};

		const result = await new AdaptOrchClient(transport).routeTopology({ subtasks: [] });

		expect(result.classification).toBe("hybrid");
	});

	it.each([undefined, null, {}, { topology: "singleton" }, { topology: 42 }])(
		"rejects malformed or obsolete topology responses: %j",
		async (raw) => {
			const transport: AdaptOrchTransport = { callTool: async () => raw };
			await expect(new AdaptOrchClient(transport).routeTopology({ subtasks: [] })).rejects.toThrow(
				"invalid topology",
			);
		},
	);
});
