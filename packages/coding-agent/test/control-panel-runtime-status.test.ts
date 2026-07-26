import { describe, expect, it } from "vitest";
import {
	classifyMcpStability,
	countRoutableNonHubSkills,
	countStableMcpServers,
	parseHeadroomVersionOutput,
} from "../src/modes/interactive/components/control-panel-runtime-status.ts";

function mcpEntry(
	overrides: {
		commandSummary?: string;
		overriddenBy?: string;
		authRule?: string;
		networkRule?: string;
		malformed?: boolean;
		unknownCapabilities?: readonly string[];
	} = {},
) {
	return {
		commandSummary: overrides.commandSummary ?? "npx stable-mcp",
		...(overrides.overriddenBy ? { overriddenBy: overrides.overriddenBy } : {}),
		authDecision: { rule: overrides.authRule ?? "mcp.auth.none" },
		networkDecision: { rule: overrides.networkRule ?? "mcp.network.unspecified" },
		capabilityDecision: {
			malformed: overrides.malformed ?? false,
			unknownCapabilities: [...(overrides.unknownCapabilities ?? [])],
		},
	};
}

describe("control panel runtime status helpers", () => {
	it("counts only stable MCP entries for the runtime badge", () => {
		expect(
			countStableMcpServers([
				mcpEntry(),
				mcpEntry({ commandSummary: "<unknown>" }),
				mcpEntry({ commandSummary: "sudo npx risky-mcp" }),
				mcpEntry({ authRule: "mcp.auth.invalid" }),
				mcpEntry({ networkRule: "mcp.network.invalid_mode" }),
				mcpEntry({ malformed: true }),
				mcpEntry({ unknownCapabilities: ["root"] }),
				mcpEntry({ overriddenBy: "/tmp/other-mcp.json" }),
			]),
		).toBe(1);
	});

	it("classifies MCP entries into stable / overridden / unstable for the rail dots", () => {
		expect(classifyMcpStability(mcpEntry())).toBe("stable");
		expect(classifyMcpStability(mcpEntry({ overriddenBy: "/tmp/other-mcp.json" }))).toBe("overridden");
		expect(classifyMcpStability(mcpEntry({ commandSummary: "<unknown>" }))).toBe("unstable");
		expect(classifyMcpStability(mcpEntry({ commandSummary: "sudo npx risky-mcp" }))).toBe("unstable");
		expect(classifyMcpStability(mcpEntry({ authRule: "mcp.auth.invalid" }))).toBe("unstable");
		expect(classifyMcpStability(mcpEntry({ networkRule: "mcp.network.invalid_mode" }))).toBe("unstable");
		expect(classifyMcpStability(mcpEntry({ malformed: true }))).toBe("unstable");
		expect(classifyMcpStability(mcpEntry({ unknownCapabilities: ["root"] }))).toBe("unstable");
	});

	it("parses Headroom 3.0 and legacy version outputs", () => {
		expect(parseHeadroomVersionOutput("github.com/headroomlabs-ai/headroom 3.0")).toBe("3.0");
		expect(parseHeadroomVersionOutput("headroom version 3.0.1\n")).toBe("3.0.1");
		expect(parseHeadroomVersionOutput("headroom, version 0.22.4")).toBe("0.22.4");
		expect(parseHeadroomVersionOutput("headroom unavailable")).toBeNull();
	});

	it("excludes OMK hub skills from the displayed skill total", () => {
		expect(
			countRoutableNonHubSkills([
				{ name: "omk-skills" },
				{ name: "omk-frontend" },
				{ name: "omk-loop" },
				{ name: "programming" },
				{ name: "headroom" },
			]),
		).toBe(2);
	});
});
