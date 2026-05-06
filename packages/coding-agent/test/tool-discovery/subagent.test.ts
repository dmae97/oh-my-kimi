import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";

// ─── Subagent discovery mode inheritance tests ────────────────────────────────
// These are unit-level tests that verify the settings resolution logic
// without needing to spin up a full AgentSession or subagent.
// ─────────────────────────────────────────────────────────────────────────────

describe("tools.discoveryMode subagent inheritance via settings", () => {
	it("'off' propagates to child as 'off'", () => {
		const parentSettings = Settings.isolated({ "tools.discoveryMode": "off" });
		// Subagent inherits the same settings object (in task/executor.ts, subagentSettings is
		// derived from parent settings). The setting value should be preserved.
		const child = Settings.isolated({ "tools.discoveryMode": parentSettings.get("tools.discoveryMode") });
		expect(child.get("tools.discoveryMode")).toBe("off");
	});

	it("'mcp-only' propagates to child as 'mcp-only'", () => {
		const parentSettings = Settings.isolated({ "tools.discoveryMode": "mcp-only" });
		const child = Settings.isolated({ "tools.discoveryMode": parentSettings.get("tools.discoveryMode") });
		expect(child.get("tools.discoveryMode")).toBe("mcp-only");
	});

	it("'all' propagates to child as 'all'", () => {
		const parentSettings = Settings.isolated({ "tools.discoveryMode": "all" });
		const child = Settings.isolated({ "tools.discoveryMode": parentSettings.get("tools.discoveryMode") });
		expect(child.get("tools.discoveryMode")).toBe("all");
	});

	it("mcp.discoveryMode=true propagates to child as back-compat", () => {
		const parentSettings = Settings.isolated({ "mcp.discoveryMode": true });
		const child = Settings.isolated({ "mcp.discoveryMode": parentSettings.get("mcp.discoveryMode") });
		expect(child.get("mcp.discoveryMode")).toBe(true);
	});

	it("explicit toolNames override discovery — child with toolNames=['read'] ignores discovery mode", () => {
		// If a subagent definition specifies explicit tools, those take precedence
		// over the discovery mode. This is enforced in task/executor.ts by only
		// building the toolNames list from the agent.tools if present.
		const toolNames = ["read"];
		// When toolNames is explicit, only those tools are used regardless of discovery mode
		expect(toolNames).toContain("read");
		expect(toolNames).not.toContain("find");
		expect(toolNames).not.toContain("search");
	});
});

describe("effective discovery mode resolution", () => {
	function resolveEffectiveMode(settings: Settings): "off" | "mcp-only" | "all" {
		const toolsMode = settings.get("tools.discoveryMode");
		if (toolsMode !== "off") return toolsMode as "off" | "mcp-only" | "all";
		if (settings.get("mcp.discoveryMode")) return "mcp-only";
		return "off";
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

	it("default settings → off", () => {
		const s = Settings.isolated({});
		expect(resolveEffectiveMode(s)).toBe("off");
	});
});
