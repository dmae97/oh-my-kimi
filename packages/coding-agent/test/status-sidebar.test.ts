import { fileURLToPath } from "node:url";
import { visibleWidth } from "omk-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { McpInventory, McpServerEntry } from "../src/core/mcp-inventory.ts";
import {
	mcpMaxRows,
	STATUS_SIDEBAR_MAX_WIDTH,
	STATUS_SIDEBAR_WIDTH,
	StatusSidebarComponent,
	statusSidebarWidth,
} from "../src/modes/interactive/components/status-sidebar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// Deterministic MCP roster so the rail test does not depend on the host's real config.
vi.mock("../src/core/mcp-inventory.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/mcp-inventory.ts")>();
	return {
		...actual,
		loadMcpInventory: vi.fn(() => mockInventory),
	};
});

function entry(name: string, overrides: Partial<McpServerEntry> = {}): McpServerEntry {
	return {
		name,
		source: "/tmp/mcp.json",
		commandSummary: "npx some-mcp",
		envKeys: [],
		argsCount: 0,
		autoApproveCount: 0,
		networkDecision: {
			allowed: true,
			mode: "none",
			rule: "mcp.network.none",
			reason: "",
			allowedDomains: [],
			deniedDomains: [],
			allowUnixSockets: [],
		},
		capabilityDecision: {
			trustedCapabilities: [],
			malformed: false,
			unknownCapabilities: [],
			rule: "mcp.capability.none",
			reason: "",
		},
		samplingDecision: {
			allowed: false,
			mode: "disabled",
			humanApprovalRequired: false,
			rule: "mcp.sampling.none",
			reason: "",
		},
		authDecision: { mode: "none", envKeys: [], rule: "mcp.auth.none", reason: "" },
		...overrides,
	};
}

const mockInventory: McpInventory = {
	entries: [
		entry("adaptorch"),
		entry("chrome-devtools"),
		entry("filesystem", { overriddenBy: "/tmp/other.json" }),
		entry("ghidra", { commandSummary: "<unknown>" }),
	],
	presets: [],
	sources: [],
	errors: [],
};

function makeSession() {
	return {
		state: {
			model: { id: "claude-test", reasoning: true, contextWindow: 200000, provider: "anthropic" },
			thinkingLevel: "high",
		},
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionName: () => "rail-test",
			getEntries: () => [],
		},
		getContextUsage: () => ({ percent: 42, contextWindow: 200000, tokens: 84000 }),
		modelRegistry: { isUsingOAuth: () => false },
		autoCompactionEnabled: true,
	};
}

function makeFooterData() {
	return {
		getGitBranch: () => "main",
		getCpuPercent: () => 37,
		getMemoryRssBytes: () => 512 * 1024 * 1024,
		getSystemCpuPercent: () => null,
		getSystemMemoryUsedBytes: () => null,
		getSystemMemoryTotalBytes: () => null,
		getPackageIntakeSummary: () => ({
			total: 5,
			acceptedNative: 3,
			acceptedReference: 1,
			acceptedMeasurement: 1,
			acceptedAdvisory: 0,
			deferred: 0,
			reject: 0,
			hardForkBlocked: 0,
		}),
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
	};
}

beforeAll(() => {
	process.env.OMK_PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
	initTheme("omk-neon-control");
});

describe("StatusSidebarComponent (pinned opencode-style rail)", () => {
	it("renders a full-height rail with every line clipped to the rail width", () => {
		const sidebar = new StatusSidebarComponent(
			() => makeSession() as never,
			makeFooterData() as never,
			() => true,
		);
		const lines = sidebar.render(STATUS_SIDEBAR_WIDTH);
		expect(lines.length).toBeGreaterThan(10);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(STATUS_SIDEBAR_WIDTH);
		}
	});

	it("shows the MCP roster with a stable/total counter and stability dots", () => {
		const sidebar = new StatusSidebarComponent(
			() => makeSession() as never,
			makeFooterData() as never,
			() => true,
		);
		const text = stripAnsi(sidebar.render(STATUS_SIDEBAR_WIDTH).join("\n"));
		// 2 stable of 4 total → counter in the section rule.
		expect(text).toContain("MCP");
		expect(text).toContain("2/4");
		// Server names are listed.
		expect(text).toContain("adaptorch");
		expect(text).toContain("chrome-devtools");
		expect(text).toContain("filesystem");
		expect(text).toContain("ghidra");
		// Stability dots: stable (●), overridden (◐), unstable (○).
		expect(text).toContain("●");
		expect(text).toContain("◐");
		expect(text).toContain("○");
	});

	it("renders the live header elements (uptime + activity sparkline)", () => {
		const sidebar = new StatusSidebarComponent(
			() => makeSession() as never,
			makeFooterData() as never,
			() => true,
		);
		const text = stripAnsi(sidebar.render(STATUS_SIDEBAR_WIDTH).join("\n"));
		expect(text).toContain("up");
		expect(text).toContain("act");
	});

	it("collapses long rosters into a '+N more' line", () => {
		const many = Array.from({ length: 12 }, (_, i) => entry(`server-${i}`));
		mockInventory.entries = many;
		const sidebar = new StatusSidebarComponent(
			() => makeSession() as never,
			makeFooterData() as never,
			() => true,
		);
		const text = stripAnsi(sidebar.render(STATUS_SIDEBAR_WIDTH).join("\n"));
		expect(text).toContain("+4 more");
		expect(text).toContain("12/12");
		// Only the first 8 rows are rendered (default 32-row terminal).
		expect(text).toContain("server-7");
		expect(text).not.toContain("server-8");
	});

	it("scales the rail width with the terminal (responsive, clamped)", () => {
		expect(statusSidebarWidth(96)).toBe(STATUS_SIDEBAR_WIDTH); // floor(24.9) → min 34
		expect(statusSidebarWidth(140)).toBe(36);
		expect(statusSidebarWidth(160)).toBe(41);
		expect(statusSidebarWidth(200)).toBe(STATUS_SIDEBAR_MAX_WIDTH); // capped at 48
		expect(statusSidebarWidth(400)).toBe(STATUS_SIDEBAR_MAX_WIDTH);
	});

	it("lists more MCP servers on taller terminals", () => {
		expect(mcpMaxRows(24)).toBe(4);
		expect(mcpMaxRows(32)).toBe(8);
		expect(mcpMaxRows(40)).toBe(16);
		expect(mcpMaxRows(60)).toBe(18); // capped

		mockInventory.entries = Array.from({ length: 12 }, (_, i) => entry(`server-${i}`));
		const tall = new StatusSidebarComponent(
			() => makeSession() as never,
			makeFooterData() as never,
			() => true,
			() => 40,
		);
		const text = stripAnsi(tall.render(statusSidebarWidth(200)).join("\n"));
		// 16 rows available → all 12 servers listed, no collapse line.
		expect(text).toContain("server-11");
		expect(text).not.toContain("more…");
	});

	it("renders cleanly at the maximum rail width", () => {
		const sidebar = new StatusSidebarComponent(
			() => makeSession() as never,
			makeFooterData() as never,
			() => true,
			() => 50,
		);
		const lines = sidebar.render(STATUS_SIDEBAR_MAX_WIDTH);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(STATUS_SIDEBAR_MAX_WIDTH);
		}
	});
});
