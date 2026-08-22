import { describe, expect, it } from "vitest";
import { AdaptOrchClient, type AdaptOrchTransport } from "../src/adaptorch-client.ts";

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
