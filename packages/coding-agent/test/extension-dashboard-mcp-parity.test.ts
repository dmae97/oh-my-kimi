/**
 * Regression guard for issue #3827.
 *
 * `/mcp list` and the `/extensions` dashboard MUST agree on whether a given MCP
 * server is enabled or disabled. The two read paths historically diverged: the
 * dashboard's `loadAllExtensions` only consulted the dashboard-private
 * `disabledExtensions` settings array, while `/mcp list` (and the MCP runtime
 * itself) honored both the per-server `enabled` flag in `mcp.json` and the
 * user-level `disabledServers` denylist.
 *
 * The fixtures below cover both inputs and the round-trip the dashboard's
 * MCP toggle uses (`setServerDisabled`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { readMCPConfigFile, setMcpServerEnabled, setServerDisabled } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import { __resetDirsFromEnvForTests, getMCPConfigPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

describe("loadAllExtensions MCP parity with /mcp list (issue #3827)", () => {
	let projectDir = "";
	let userAgentDir = "";

	beforeEach(async () => {
		resetSettingsForTest();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-3827-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-3827-user-"));

		// Redirect user-scoped mcp.json (resolved via getAgentDir() at the call
		// site) into the per-test temp directory so neither the discovery loader
		// nor the denylist reader touches the real user profile.
		setAgentDir(userAgentDir);

		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"denylisted-server": { command: "echo", args: ["denylisted"] },
					"flag-disabled-server": { command: "echo", args: ["flag"], enabled: false },
					"active-server": { command: "echo", args: ["active"] },
				},
			}),
		);

		// User-level mcp.json carries the denylist; this is what `/mcp disable`
		// writes through setServerDisabled().
		await fs.writeFile(
			path.join(userAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {},
				disabledServers: ["denylisted-server"],
			}),
		);

		const settings = await Settings.init({ inMemory: true, cwd: projectDir });
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		__resetDirsFromEnvForTests();
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("treats a server in user-level disabledServers as disabled (matches /mcp list)", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const denylisted = extensions.find(e => e.id === "mcp:denylisted-server");
		expect(denylisted).toBeDefined();
		expect(denylisted!.state).toBe("disabled");
		expect(denylisted!.disabledReason).toBe("item-disabled");
	});

	test("treats a server with enabled:false as disabled (matches /mcp list)", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const flagDisabled = extensions.find(e => e.id === "mcp:flag-disabled-server");
		expect(flagDisabled).toBeDefined();
		expect(flagDisabled!.state).toBe("disabled");
		expect(flagDisabled!.disabledReason).toBe("item-disabled");
	});

	test("leaves untouched servers active", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const active = extensions.find(e => e.id === "mcp:active-server");
		expect(active).toBeDefined();
		expect(active!.state).toBe("active");
		expect(active!.disabledReason).toBeUndefined();
	});

	test("setServerDisabled round-trips through the dashboard view", async () => {
		// Re-enable `denylisted-server` through the canonical writer the
		// dashboard's MCP toggle now calls. The dashboard view MUST flip to
		// active on the next load.
		await setServerDisabled(getMCPConfigPath("user", projectDir), "denylisted-server", false);
		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:denylisted-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");

		// The inverse path: disabling `active-server` via the writer flips the
		// dashboard view to disabled.
		await setServerDisabled(getMCPConfigPath("user", projectDir), "active-server", true);
		const disabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:active-server");
		expect(disabled).toBeDefined();
		expect(disabled!.state).toBe("disabled");
		expect(disabled!.disabledReason).toBe("item-disabled");
	});

	test("dashboard re-enable flips enabled:false in mcp.json (PR #3829 review)", async () => {
		// The bug: when a server has `enabled: false` in mcp.json, the dashboard
		// toggle previously only removed it from the user-level denylist, so
		// state-manager's `server.enabled === false` check kept it disabled.
		// setMcpServerEnabled MUST overwrite the per-server flag.
		const projectMcpPath = path.join(projectDir, ".omp", "mcp.json");

		await setMcpServerEnabled(
			getMCPConfigPath("user", projectDir),
			getMCPConfigPath("project", projectDir),
			"flag-disabled-server",
			true,
		);

		const projectConfig = await readMCPConfigFile(projectMcpPath);
		expect(projectConfig.mcpServers?.["flag-disabled-server"]?.enabled).toBe(true);

		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:flag-disabled-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");
	});

	test("dashboard re-enable also clears a stale denylist entry on a config-resident server", async () => {
		// Manually disable `active-server` via BOTH the per-server flag and the
		// denylist, simulating a server that's been toggled off multiple ways.
		const projectMcpPath = path.join(projectDir, ".omp", "mcp.json");
		const initial = await readMCPConfigFile(projectMcpPath);
		await Bun.write(
			projectMcpPath,
			JSON.stringify({
				...initial,
				mcpServers: {
					...initial.mcpServers,
					"active-server": { ...initial.mcpServers!["active-server"], enabled: false },
				},
			}),
		);
		await setServerDisabled(getMCPConfigPath("user", projectDir), "active-server", true);

		await setMcpServerEnabled(
			getMCPConfigPath("user", projectDir),
			getMCPConfigPath("project", projectDir),
			"active-server",
			true,
		);

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).not.toContain("active-server");

		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:active-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");
	});

	test("dashboard disable on a config-resident server writes enabled:false (not denylist)", async () => {
		await setMcpServerEnabled(
			getMCPConfigPath("user", projectDir),
			getMCPConfigPath("project", projectDir),
			"active-server",
			false,
		);

		const projectConfig = await readMCPConfigFile(path.join(projectDir, ".omp", "mcp.json"));
		expect(projectConfig.mcpServers?.["active-server"]?.enabled).toBe(false);

		// The denylist is reserved for discovered (config-less) servers; a
		// config-resident server's `enabled: false` flag is the canonical signal.
		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).not.toContain("active-server");

		const disabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:active-server");
		expect(disabled).toBeDefined();
		expect(disabled!.state).toBe("disabled");
	});

	test("dashboard toggles on a discovered (config-less) server use the denylist", async () => {
		// `phantom-server` is not in any config; only the denylist can suppress it.
		await setMcpServerEnabled(
			getMCPConfigPath("user", projectDir),
			getMCPConfigPath("project", projectDir),
			"phantom-server",
			false,
		);

		let userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).toContain("phantom-server");

		await setMcpServerEnabled(
			getMCPConfigPath("user", projectDir),
			getMCPConfigPath("project", projectDir),
			"phantom-server",
			true,
		);

		userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).not.toContain("phantom-server");
	});
});
