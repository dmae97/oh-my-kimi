import { afterEach, describe, expect, it, vi } from "bun:test";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

function createTestSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function createSettingsWithOverrides(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
	return Settings.isolated({
		"lsp.formatOnWrite": true,
		"bashInterceptor.enabled": true,
		...overrides,
	});
}

function createDiscoverySessionHooks(): Partial<ToolSession> {
	const selected: string[] = [];
	return {
		isMCPDiscoveryEnabled: () => true,
		getDiscoverableMCPTools: () => [],
		getSelectedMCPToolNames: () => [...selected],
		activateDiscoveredMCPTools: async toolNames => {
			const activated: string[] = [];
			for (const name of toolNames) {
				if (!selected.includes(name)) {
					selected.push(name);
					activated.push(name);
				}
			}
			return activated;
		},
	};
}

describe("createTools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates all builtin tools by default", async () => {
		const session = createTestSession();
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		// Core tools should always be present
		expect(names).toContain("python");
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).toContain("edit");
		expect(names).toContain("write");
		expect(names).toContain("grep");
		expect(names).toContain("find");
		expect(names).toContain("lsp");
		expect(names).toContain("notebook");
		expect(names).toContain("task");
		expect(names).toContain("todo_write");
		expect(names).toContain("web_search");
		expect(names).toContain("exit_plan_mode");
		expect(names).not.toContain("fetch");
		expect(names).not.toContain("vim");
	});

	it("keeps edit visible when vim edit mode is active", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"edit.mode": "vim",
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("edit");
		expect(names).not.toContain("vim");
	});

	it("includes bash and python when python mode is both", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"python.toolMode": "both",
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("python");
		expect(names).toContain("bash");
	});

	it("includes bash when python mode is bash-only", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"python.toolMode": "bash-only",
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("bash");
		expect(names).not.toContain("python");
	});

	it("includes bash when python unavailable and python requested", async () => {
		const session = createTestSession();
		vi.spyOn(await import("@oh-my-pi/pi-coding-agent/ipy/kernel"), "checkPythonKernelAvailability").mockResolvedValue(
			{
				ok: false,
				reason: "missing python",
			},
		);
		const tools = await createTools(session, ["python"]);
		const names = tools.map(t => t.name);

		expect(names).toContain("bash");
		expect(names).toContain("exit_plan_mode");
		expect(names).not.toContain("python");
	});

	it("excludes lsp tool when session disables LSP", async () => {
		const session = createTestSession({ enableLsp: false });
		const tools = await createTools(session, ["read", "lsp", "write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write", "exit_plan_mode"]);
	});

	it("excludes lsp tool when disabled", async () => {
		const session = createTestSession({ enableLsp: false });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("lsp");
	});

	it("respects requested tool subset", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["read", "write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write", "exit_plan_mode"]);
	});

	it("ignores vim as an unknown requested tool even when vim edit mode is active", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"edit.mode": "vim",
			}),
		});
		const tools = await createTools(session, ["read", "vim"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "exit_plan_mode"]);
	});

	it("lowercases requested tool subset", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["Read", "Write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write", "exit_plan_mode"]);
	});

	it("includes hidden tools when explicitly requested", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["report_finding"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["report_finding", "exit_plan_mode"]);
	});

	it("includes submit_result tool when required", async () => {
		const session = createTestSession({ requireSubmitResultTool: true });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("submit_result");
	});

	it("excludes ask tool when hasUI is false", async () => {
		const session = createTestSession({ hasUI: false });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("ask");
	});

	it("includes ask tool when hasUI is true", async () => {
		const session = createTestSession({ hasUI: true });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("ask");
	});

	it("filters disabled builtin tools by settings", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"find.enabled": false,
				"grep.enabled": false,
				"astGrep.enabled": false,
				"astEdit.enabled": false,
				"renderMermaid.enabled": false,
				"web_search.enabled": false,
				"notebook.enabled": false,
				"browser.enabled": false,
				"inspect_image.enabled": false,
				"calc.enabled": false,
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("find");
		expect(names).not.toContain("grep");
		expect(names).not.toContain("ast_grep");
		expect(names).not.toContain("ast_edit");
		expect(names).not.toContain("render_mermaid");
		expect(names).not.toContain("web_search");
		expect(names).not.toContain("notebook");
		expect(names).not.toContain("browser");
		expect(names).not.toContain("inspect_image");
		expect(names).not.toContain("calc");
	});

	it("includes search_tool_bm25 when MCP tool discovery is enabled and executable", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"mcp.discoveryMode": true,
			}),
			...createDiscoverySessionHooks(),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("search_tool_bm25");
	});

	it("HIDDEN_TOOLS contains review tools", () => {
		expect(Object.keys(HIDDEN_TOOLS).sort()).toEqual([
			"exit_plan_mode",
			"report_finding",
			"report_tool_issue",
			"resolve",
			"submit_result",
		]);
	});
});
