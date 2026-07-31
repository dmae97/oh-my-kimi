import { fileURLToPath } from "node:url";
import { visibleWidth } from "omk-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { McpInventory, McpServerEntry } from "../src/core/mcp-inventory.ts";
import { recordClaudePassiveUsage } from "../src/core/provider-usage.ts";
import {
	mcpMaxRows,
	parseCodexUsageSnapshot,
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
		entry("\u001b[31mevil\u202ename\nnext", { commandSummary: "<unknown>" }),
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
		modelRegistry: {
			isUsingOAuth: () => false,
			isUsingOAuthProvider: (_provider: string) => false,
			getProviderAuthStatus: (_provider: string) => ({ configured: false }),
			getApiKeyForProvider: async (): Promise<string | undefined> => undefined,
			getApiKeyAndHeaders: async (): Promise<
				{ ok: true; apiKey: string; headers?: Record<string, string> } | { ok: false; error: string }
			> => ({ ok: false, error: "not configured in tests" }),
		},
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
			() => 40,
		);
		const text = stripAnsi(sidebar.render(STATUS_SIDEBAR_WIDTH).join("\n"));
		// 2 stable of 5 total → counter in the section rule.
		expect(text).toContain("MCP");
		expect(text).toContain("2/5");
		// Server names are listed.
		expect(text).toContain("adaptorch");
		expect(text).toContain("chrome-devtools");
		expect(text).toContain("filesystem");
		expect(text).toContain("ghidra");
		expect(text).toContain("evilname next");
		expect(text).not.toContain("\u202e");
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

	it("renders Codex 5H and 7D quota bars on separate status lines", async () => {
		const session = makeSession();
		session.state.model.provider = "openai-codex";
		session.modelRegistry.isUsingOAuth = () => true;
		session.modelRegistry.isUsingOAuthProvider = (provider) => provider === "openai-codex";
		const requestRender = vi.fn();
		const sidebar = new StatusSidebarComponent(
			() => session as never,
			makeFooterData() as never,
			() => true,
			() => 32,
			{
				requestRender,
				fetchCodexUsage: async () => ({
					fiveHour: { usedPercent: 42, resetsAt: Math.floor(Date.now() / 1000) + 2 * 60 * 60 },
					sevenDay: { usedPercent: 7, resetsAt: Math.floor(Date.now() / 1000) + 4 * 24 * 60 * 60 },
				}),
			},
		);

		sidebar.render(STATUS_SIDEBAR_WIDTH);
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
		const lines = sidebar.render(STATUS_SIDEBAR_WIDTH);
		const plainLines = lines.map(stripAnsi);
		const text = plainLines.join("\n");
		expect(text).toContain("USAGE");
		expect(plainLines.some((line) => line.includes("5H") && line.includes("42%"))).toBe(true);
		expect(plainLines.some((line) => line.includes("7D") && line.includes("7%"))).toBe(true);
		expect(text).toContain("reset");
		expect(text).toContain("█");
		expect(text).toContain("░");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(STATUS_SIDEBAR_WIDTH);
		}
	});

	it("renders quota windows for non-Codex subscription providers", async () => {
		const session = makeSession();
		session.state.model.provider = "anthropic";
		session.modelRegistry.isUsingOAuth = () => true;
		session.modelRegistry.isUsingOAuthProvider = (provider) => provider === "anthropic";
		const requestRender = vi.fn();
		const sidebar = new StatusSidebarComponent(
			() => session as never,
			makeFooterData() as never,
			() => true,
			() => 32,
			{
				requestRender,
				fetchSubscriptionUsage: async () => ({
					label: "CLAUDE",
					windows: [
						{ label: "5H", usedPercent: 35 },
						{ label: "7D", usedPercent: 18 },
					],
				}),
			},
		);

		sidebar.render(STATUS_SIDEBAR_WIDTH);
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
		const plainLines = sidebar.render(STATUS_SIDEBAR_WIDTH).map(stripAnsi);
		const text = plainLines.join("\n");
		expect(text).toContain("CLAUDE");
		expect(plainLines.some((line) => line.includes("5H") && line.includes("35%"))).toBe(true);
		expect(plainLines.some((line) => line.includes("7D") && line.includes("18%"))).toBe(true);
	});

	it("refreshes Claude quota immediately after passive headers arrive", async () => {
		const session = makeSession();
		session.state.model.provider = "anthropic";
		session.modelRegistry.isUsingOAuth = () => true;
		session.modelRegistry.isUsingOAuthProvider = (provider) => provider === "anthropic";
		let usedPercent = 35;
		const fetchSubscriptionUsage = vi.fn(async () => ({
			label: "CLAUDE",
			windows: [{ label: "5H", usedPercent }],
		}));
		const requestRender = vi.fn();
		const sidebar = new StatusSidebarComponent(
			() => session as never,
			makeFooterData() as never,
			() => true,
			() => 32,
			{ requestRender, fetchSubscriptionUsage },
		);

		sidebar.render(STATUS_SIDEBAR_WIDTH);
		await vi.waitFor(() => expect(fetchSubscriptionUsage).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalledTimes(1));
		usedPercent = 48;
		recordClaudePassiveUsage("test-sidebar-claude-token", {
			limitId: "anthropic-unified",
			primary: {
				usedPercent,
				windowSeconds: 5 * 60 * 60,
				resetsAt: Math.floor(Date.now() / 1000) + 3_600,
			},
		});
		sidebar.render(STATUS_SIDEBAR_WIDTH);

		await vi.waitFor(() => expect(fetchSubscriptionUsage).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => {
			const text = stripAnsi(sidebar.render(STATUS_SIDEBAR_WIDTH).join("\n"));
			expect(text).toContain("48%");
		});
	});

	it("identifies a configured Model Studio Token Plan as console-only quota", async () => {
		const session = makeSession();
		session.state.model.provider = "modelstudio-maas";
		session.modelRegistry.getProviderAuthStatus = (provider) => ({
			configured: provider === "modelstudio-maas",
		});
		const requestRender = vi.fn();
		const sidebar = new StatusSidebarComponent(
			() => session as never,
			makeFooterData() as never,
			() => true,
			() => 32,
			{ requestRender },
		);

		sidebar.render(STATUS_SIDEBAR_WIDTH);
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
		const text = stripAnsi(sidebar.render(STATUS_SIDEBAR_WIDTH).join("\n"));
		expect(text).toContain("QWEN TOKEN PLAN");
		expect(text).toContain("console-only quota");
	});

	it("renders every configured provider while quota requests settle independently", async () => {
		const session = makeSession();
		session.state.model.provider = "openai-codex";
		session.modelRegistry.isUsingOAuth = () => true;
		session.modelRegistry.isUsingOAuthProvider = (provider) =>
			provider === "openai-codex" || provider === "anthropic";
		let resolveCodex:
			| ((snapshot: { label: string; windows: { label: string; usedPercent: number }[] }) => void)
			| undefined;
		const requestRender = vi.fn();
		const sidebar = new StatusSidebarComponent(
			() => session as never,
			makeFooterData() as never,
			() => true,
			() => 32,
			{
				requestRender,
				fetchSubscriptionUsage: async (_session, provider) => {
					if (provider === "openai-codex") {
						return new Promise((resolve) => {
							resolveCodex = resolve;
						});
					}
					return { label: "CLAUDE", windows: [{ label: "5H", usedPercent: 22 }] };
				},
			},
		);

		sidebar.render(STATUS_SIDEBAR_WIDTH);
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalledTimes(1));
		let text = stripAnsi(sidebar.render(STATUS_SIDEBAR_WIDTH).join("\n"));
		expect(text).toContain("CODEX loading…");
		expect(text).toContain("CLAUDE");
		expect(text).toContain("22%");

		resolveCodex?.({ label: "CODEX", windows: [{ label: "7D", usedPercent: 41 }] });
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalledTimes(2));
		text = stripAnsi(sidebar.render(STATUS_SIDEBAR_WIDTH).join("\n"));
		expect(text).toContain("CODEX");
		expect(text).toContain("41%");
		expect(text).toContain("CLAUDE");
		expect(text).toContain("22%");
	});

	it("loads subscription quota from the official endpoint with the OAuth account header", async () => {
		const session = makeSession();
		session.state.model.provider = "openai-codex";
		session.modelRegistry.isUsingOAuth = () => true;
		session.modelRegistry.isUsingOAuthProvider = (provider) => provider === "openai-codex";
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
		).toString("base64url");
		const token = `header.${payload}.signature`;
		session.modelRegistry.getApiKeyForProvider = async () => token;
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				rate_limit: {
					primary_window: { used_percent: 31, limit_window_seconds: 5 * 60 * 60 },
					secondary_window: { used_percent: 12, limit_window_seconds: 7 * 24 * 60 * 60 },
				},
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const requestRender = vi.fn();
			const sidebar = new StatusSidebarComponent(
				() => session as never,
				makeFooterData() as never,
				() => true,
				() => 32,
				{ requestRender },
			);
			sidebar.render(STATUS_SIDEBAR_WIDTH);
			await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
			expect(fetchMock).toHaveBeenCalledWith(
				"https://chatgpt.com/backend-api/wham/usage",
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: `Bearer ${token}`,
						"chatgpt-account-id": "account-test",
					}),
				}),
			);
			const text = stripAnsi(sidebar.render(STATUS_SIDEBAR_WIDTH).join("\n"));
			expect(text).toContain("31%");
			expect(text).toContain("12%");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("identifies 5h and 7d windows by duration instead of response order", () => {
		expect(
			parseCodexUsageSnapshot({
				rate_limit: {
					primary_window: { used_percent: 9, limit_window_seconds: 7 * 24 * 60 * 60, reset_at: 111 },
					secondary_window: { used_percent: 41, limit_window_seconds: 5 * 60 * 60, reset_at: 222 },
				},
			}),
		).toEqual({
			fiveHour: { usedPercent: 41, resetsAt: 222 },
			sevenDay: { usedPercent: 9, resetsAt: 111 },
		});
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
