import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentToolSettingsError, resolveAgentToolSettings } from "../src/core/agent-tool-settings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const MAX_TOOL_TIMEOUT_MS = 2_147_483_647;

describe("resolveAgentToolSettings", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `omk-agent-tool-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(join(cwd, ".omk"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createManager(globalAgent: unknown, projectAgent?: unknown): SettingsManager {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agent: globalAgent }));
		if (projectAgent !== undefined) {
			writeFileSync(join(cwd, ".omk", "settings.json"), JSON.stringify({ agent: projectAgent }));
		}
		return SettingsManager.create(cwd, agentDir);
	}

	it("merges global and project per-tool timeout maps with project precedence", () => {
		// Given: distinct global/project entries and one overlapping tool name.
		const manager = createManager(
			{ toolTimeouts: { global_tool: 7_000, read: 5_000 } },
			{ toolTimeouts: { project_tool: 8_000, read: 6_000 } },
		);

		// When: the effective runtime policy is resolved.
		const result = resolveAgentToolSettings(manager, {});

		// Then: both scopes survive and the project value wins the overlap.
		expect(result.toolTimeouts.global_tool).toBe(7_000);
		expect(result.toolTimeouts.project_tool).toBe(8_000);
		expect(result.toolTimeouts.read).toBe(6_000);
	});

	it("rejects an array masquerading as a per-tool timeout map", () => {
		// Given: malformed external JSON for agent.toolTimeouts.
		const manager = createManager({ toolTimeouts: [1_000] });

		// When/Then: the boundary parser fails closed.
		expect(() => resolveAgentToolSettings(manager, {})).toThrow(AgentToolSettingsError);
	});

	it.each([0.5, MAX_TOOL_TIMEOUT_MS + 1])("rejects unsupported global timeout value %s", (timeoutMs) => {
		// Given: a fractional or timer-overflowing global timeout.
		const manager = createManager({ toolTimeoutMs: timeoutMs });

		// When/Then: the boundary parser fails closed instead of changing the timer policy.
		expect(() => resolveAgentToolSettings(manager, {})).toThrow("Invalid agent.toolTimeoutMs");
	});

	it("rejects an unsupported per-tool timeout value", () => {
		// Given: a per-name timeout beyond the Node timer range.
		const manager = createManager({ toolTimeouts: { custom_tool: MAX_TOOL_TIMEOUT_MS + 1 } });

		// When/Then: the boundary parser identifies the exact invalid entry.
		expect(() => resolveAgentToolSettings(manager, {})).toThrow("Invalid agent.toolTimeouts.custom_tool");
	});

	it("preserves prototype-shaped tool names as own timeout entries", () => {
		// Given: valid custom tool names that also exist on Object.prototype.
		writeFileSync(
			join(agentDir, "settings.json"),
			'{"agent":{"toolTimeoutMs":9000,"toolTimeouts":{"__proto__":12000,"constructor":13000}}}',
		);
		const manager = SettingsManager.create(cwd, agentDir);

		// When: the effective runtime policy is resolved.
		const result = resolveAgentToolSettings(manager, {});

		// Then: exact-name lookup cannot fall through to the object prototype.
		expect(Object.hasOwn(result.toolTimeouts, "__proto__")).toBe(true);
		expect(Object.hasOwn(result.toolTimeouts, "constructor")).toBe(true);
		expect(result.toolTimeouts.__proto__).toBe(12_000);
		expect(result.toolTimeouts.constructor).toBe(13_000);
	});

	it("uses zero max concurrency as the explicit uncapped setting", () => {
		// Given: maxToolConcurrency is explicitly zero.
		const manager = createManager({ maxToolConcurrency: 0 });

		// When: the effective runtime policy is resolved.
		const result = resolveAgentToolSettings(manager, {});

		// Then: the Agent receives no width cap.
		expect(result.maxToolConcurrency).toBeUndefined();
	});
});

describe("category timeout defaults (ALG004-C)", () => {
	it("classifies tool names into §6.3 timeout categories", async () => {
		const { resolveToolTimeoutCategory } = await import("../src/core/agent-tool-settings.ts");
		// read/list/search
		for (const name of ["read", "ls", "find", "grep", "glob", "list", "search"]) {
			expect(resolveToolTimeoutCategory(name), name).toBe("read");
		}
		// write/edit
		for (const name of ["write", "edit"]) {
			expect(resolveToolTimeoutCategory(name), name).toBe("write");
		}
		// bash/process
		expect(resolveToolTimeoutCategory("bash")).toBe("process");
		// MCP request naming convention
		expect(resolveToolTimeoutCategory("mcp__context7__resolve_library_id")).toBe("mcp");
		// browser / computer-use, including browser tools bridged through MCP
		expect(resolveToolTimeoutCategory("browser_navigate")).toBe("browser");
		expect(resolveToolTimeoutCategory("computer_use")).toBe("browser");
		expect(resolveToolTimeoutCategory("computer-use")).toBe("browser");
		expect(resolveToolTimeoutCategory("mcp__playwright__browser_click")).toBe("browser");
		// everything else falls through to the global setting
		expect(resolveToolTimeoutCategory("custom_tool")).toBeUndefined();
	});

	it("exposes the §6.3 default timeout table", async () => {
		const { TOOL_CATEGORY_TIMEOUTS } = await import("../src/core/agent-tool-settings.ts");
		expect(TOOL_CATEGORY_TIMEOUTS).toEqual({
			read: 30_000,
			write: 60_000,
			mcp: 120_000,
			process: 300_000,
			browser: 180_000,
		});
	});

	it("fills category defaults only for names without explicit entries (user precedence)", async () => {
		const { applyCategoryTimeoutDefaults } = await import("../src/core/agent-tool-settings.ts");
		const merged = applyCategoryTimeoutDefaults(
			["read", "mcp__ctx__docs", "browser_navigate", "custom_tool", "bash"],
			{ read: 5_000, mcp__ctx__docs: 45_000, other_explicit: 1_000 },
		);
		expect(merged).toEqual({
			// explicit entries always win and are all preserved
			read: 5_000,
			mcp__ctx__docs: 45_000,
			other_explicit: 1_000,
			// category defaults fill the gaps for active tool names
			browser_navigate: 180_000,
			bash: 300_000,
			// custom_tool has no category: falls through to the global setting at runtime
		});
	});
});
