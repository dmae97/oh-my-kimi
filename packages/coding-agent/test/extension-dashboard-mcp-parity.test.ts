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
import { setServerDisabled } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
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
});
