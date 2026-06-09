import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	resolveEffectiveToolDiscoveryMode,
	TOOL_DISCOVERY_AUTO_THRESHOLD,
} from "@oh-my-pi/pi-coding-agent/tool-discovery/mode";

// ─── Subagent discovery mode inheritance tests ────────────────────────────────
// These are unit-level tests that verify the settings resolution logic
// without needing to spin up a full AgentSession or subagent.
// ─────────────────────────────────────────────────────────────────────────────

describe("effective discovery mode resolution", () => {
	function resolveEffectiveMode(settings: Settings, toolCount = 0): "off" | "mcp-only" | "all" {
		return resolveEffectiveToolDiscoveryMode(settings, toolCount);
	}

	it("tools.discoveryMode=all beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "all", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("all");
	});

	it("tools.discoveryMode=mcp-only beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "mcp-only", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=true → mcp-only (back-compat alias)", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": true });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=false → off", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("off");
	});

	it("default auto settings stay off at the threshold", () => {
		const s = Settings.isolated({});
		expect(s.get("tools.discoveryMode")).toBe("auto");
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD)).toBe("off");
	});

	it("default auto settings enable mcp-only above the threshold", () => {
		const s = Settings.isolated({});
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD + 1)).toBe("mcp-only");
	});
});
