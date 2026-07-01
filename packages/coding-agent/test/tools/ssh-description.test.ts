import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import * as discovery from "@oh-my-pi/pi-coding-agent/discovery";
import type { SSHHostInfo } from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import * as sshExecutor from "@oh-my-pi/pi-coding-agent/ssh/ssh-executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { loadSshTool } from "@oh-my-pi/pi-coding-agent/tools/ssh";

const SOURCE: SourceMeta = {
	provider: "test",
	providerName: "Test",
	path: "/dev/null",
	level: "user",
};

// Unique names so no persisted host-info cache file can exist for them.
const RUN_ID = `${Date.now()}-${process.pid}`;
const HOST_A: SSHHost = { name: `a-omp-test-${RUN_ID}`, host: "alpha.example.com", _source: SOURCE };
const HOST_B: SSHHost = { name: `b-omp-test-${RUN_ID}`, host: "beta.example.com", _source: SOURCE };
const LINUX_BASH_INFO: SSHHostInfo = { version: 4, os: "linux", shell: "bash", compatEnabled: false };
const WINDOWS_CMD_INFO: SSHHostInfo = { version: 4, os: "windows", shell: "cmd", compatEnabled: false };

function mockHosts(hosts: SSHHost[]): void {
	vi.spyOn(discovery, "loadCapability").mockResolvedValue({
		items: hosts,
		all: hosts,
		warnings: [],
		providers: ["test"],
	});
}

function createSession(): ToolSession {
	return { cwd: "/tmp" } as unknown as ToolSession;
}

async function loadTestTool(hosts: SSHHost[] = [HOST_A]) {
	mockHosts(hosts);
	const tool = await loadSshTool(createSession());
	if (!tool) {
		throw new Error("expected SSH tool");
	}
	return tool;
}

function stubSshExecute() {
	return vi.spyOn(sshExecutor, "executeSSH").mockResolvedValue({
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: 2,
		outputLines: 1,
		outputBytes: 2,
	});
}

function stubSshRun(info: SSHHostInfo) {
	vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue(info);
	return stubSshExecute();
}

describe("loadSshTool description", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null when no hosts are configured", async () => {
		mockHosts([]);
		expect(await loadSshTool(createSession())).toBeNull();
	});

	it("renders uncached hosts with the detecting placeholder, sorted by name, without probing", async () => {
		mockHosts([HOST_B, HOST_A]);
		const tool = await loadSshTool(createSession());
		expect(tool).not.toBeNull();
		expect(tool?.description.startsWith("Runs commands on remote hosts.")).toBe(true);
		expect(tool?.description).toContain("NEVER use `~` or `~/…`");
		expect(
			tool?.description.endsWith(
				`\n\nAvailable hosts:\n- ${HOST_A.name} (${HOST_A.host}) | detecting...\n- ${HOST_B.name} (${HOST_B.host}) | detecting...`,
			),
		).toBe(true);
	});
});

describe("SshTool cwd handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects tilde cwd values before probing or executing the host", async () => {
		const ensureSpy = vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue(LINUX_BASH_INFO);
		const executeSpy = stubSshExecute();
		const tool = await loadTestTool();

		await expect(tool.execute("call-tilde", { host: HOST_A.name, command: "pwd", cwd: "~" })).rejects.toThrow(
			"SSH cwd must be an absolute remote path",
		);
		await expect(
			tool.execute("call-tilde-path", { host: HOST_A.name, command: "pwd", cwd: "~/src" }),
		).rejects.toThrow("SSH cwd must be an absolute remote path");

		expect(ensureSpy).not.toHaveBeenCalled();
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("quotes valid POSIX absolute cwd values in the remote command", async () => {
		const executeSpy = stubSshRun(LINUX_BASH_INFO);
		const tool = await loadTestTool();

		await tool.execute("call-absolute", { host: HOST_A.name, command: "pwd", cwd: "/srv/app" });

		expect(executeSpy).toHaveBeenCalledWith(
			HOST_A,
			"cd -- '/srv/app' && pwd",
			expect.objectContaining({ compatEnabled: false, timeout: 60000 }),
		);
	});

	it("preserves native Windows cwd command generation", async () => {
		const executeSpy = stubSshRun(WINDOWS_CMD_INFO);
		const tool = await loadTestTool();

		await tool.execute("call-windows", { host: HOST_A.name, command: "dir", cwd: "C:\\Users\\me" });

		expect(executeSpy).toHaveBeenCalledWith(
			HOST_A,
			'cd /d "C:\\Users\\me" && dir',
			expect.objectContaining({ compatEnabled: false, timeout: 60000 }),
		);
	});
});
