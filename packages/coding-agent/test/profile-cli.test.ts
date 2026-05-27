import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getActiveProfile, getAgentDir, setAgentDir, setProfile } from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { runCli } from "../src/cli";
import * as profileAliasCli from "../src/cli/profile-alias";

describe("global --profile flag", () => {
	let configDir = "";
	let originalProfile: string | undefined;
	let originalAgentDir = "";
	let originalAgentDirEnv: string | undefined;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		originalAgentDir = getAgentDir();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalConfigDir = process.env.PI_CONFIG_DIR;
		configDir = `.omp-profile-cli-test-${Snowflake.next()}`;
		process.env.PI_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		if (originalProfile) {
			setProfile(originalProfile);
		} else if (originalAgentDirEnv !== undefined) {
			setAgentDir(originalAgentDir);
		} else {
			setProfile(undefined);
		}
		process.exitCode = 0;
		await fs.rm(path.join(os.homedir(), configDir), { recursive: true, force: true });
	});

	it("activates a profile before dispatching root flags", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile=work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(writeSpy).toHaveBeenCalled();
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));
	});

	it("accepts the profile flag after other root flags", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--version", "--profile", "office"]);

		expect(process.exitCode).toBe(0);
		expect(getActiveProfile()).toBe("office");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "office", "agent"));
	});

	it("installs a shell alias and exits before command dispatch", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "omp-work",
			profile: "work",
			command: "omp --profile work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile", "work", "--alias", "omp-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith({ profile: "work", aliasName: "omp-work" });
		expect(outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n")).toContain("Created omp-work");
	});

	it("rejects missing profile values without dispatching", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile", "--version"]);

		expect(process.exitCode).toBe(1);
		expect(errSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n")).toContain(
			"--profile requires a profile name",
		);
		expect(outSpy).not.toHaveBeenCalled();
	});
});
