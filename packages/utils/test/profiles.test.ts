import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetProfileSnapshotForTests,
	getActiveProfile,
	getAgentDbPath,
	getAgentDir,
	getConfigAgentDirName,
	getConfigRootDir,
	getPythonGatewayDir,
	getSessionsDir,
	getStatsDbPath,
	setAgentDir,
	setProfile,
} from "../src/dirs";
import { Snowflake } from "../src/snowflake";

describe("profile directories", () => {
	let tempRoot = "";
	let configDir = "";
	let originalAgentDir = "";
	let originalProfile: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalConfigDir: string | undefined;
	let originalXdgDataHome: string | undefined;
	let originalXdgStateHome: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalProfile = getActiveProfile();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalConfigDir = process.env.PI_CONFIG_DIR;
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		originalXdgStateHome = process.env.XDG_STATE_HOME;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		tempRoot = path.join(os.tmpdir(), "pi-utils-profiles", Snowflake.next());
		configDir = `.omp-profile-test-${Snowflake.next()}`;
		await fs.mkdir(tempRoot, { recursive: true });
		process.env.PI_CONFIG_DIR = configDir;
		// Other suites that run before this one (e.g. dirs-python-gateway) may have
		// called `setAgentDir`, which permanently mutates the module-level
		// pre-profile snapshot. Reset it here so each test starts from a clean
		// `PI_CODING_AGENT_DIR` baseline matching the env we just configured.
		delete process.env.PI_CODING_AGENT_DIR;
		__resetProfileSnapshotForTests();
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_CACHE_HOME;
	});

	afterEach(async () => {
		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		if (originalXdgDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdgDataHome;
		}
		if (originalXdgStateHome === undefined) {
			delete process.env.XDG_STATE_HOME;
		} else {
			process.env.XDG_STATE_HOME = originalXdgStateHome;
		}
		if (originalXdgCacheHome === undefined) {
			delete process.env.XDG_CACHE_HOME;
		} else {
			process.env.XDG_CACHE_HOME = originalXdgCacheHome;
		}
		if (originalProfile) {
			setProfile(originalProfile);
		} else if (originalAgentDirEnv !== undefined) {
			setAgentDir(originalAgentDir);
		} else {
			setProfile(undefined);
		}
		await fs.rm(tempRoot, { recursive: true, force: true });
		await fs.rm(path.join(os.homedir(), configDir), { recursive: true, force: true });
	});

	it("moves agent and root data under the named profile root", () => {
		setProfile("work");

		const root = path.join(os.homedir(), configDir, "profiles", "work");
		const agent = path.join(root, "agent");
		expect(getActiveProfile()).toBe("work");
		expect(getConfigRootDir()).toBe(root);
		expect(getConfigAgentDirName()).toBe(path.join(configDir, "profiles", "work", "agent"));
		expect(getAgentDir()).toBe(agent);
		expect(getAgentDbPath()).toBe(path.join(agent, "agent.db"));
		expect(getSessionsDir()).toBe(path.join(agent, "sessions"));
		expect(getStatsDbPath()).toBe(path.join(root, "stats.db"));
	});

	it("treats the default profile as regular mode", () => {
		setProfile("default");

		const root = path.join(os.homedir(), configDir);
		expect(getActiveProfile()).toBeUndefined();
		expect(getConfigRootDir()).toBe(root);
		expect(getAgentDir()).toBe(path.join(root, "agent"));
	});

	it("keeps XDG-backed named profile state under profile-specific roots", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_DATA_HOME = path.join(tempRoot, "data");
		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
		// Named profiles only adopt XDG when their *own* XDG path already exists.
		// Mkdir'ing only the base app root used to be enough (bug); the resolver
		// now requires the profile-specific path so the profile location is stable
		// across activations.
		await fs.mkdir(path.join(process.env.XDG_DATA_HOME, "omp", "profiles", "work"), { recursive: true });
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, "omp", "profiles", "work"), { recursive: true });
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, "omp", "profiles", "work"), { recursive: true });

		setProfile("work");

		expect(getAgentDbPath()).toBe(path.join(process.env.XDG_DATA_HOME, "omp", "profiles", "work", "agent.db"));
		expect(getSessionsDir()).toBe(path.join(process.env.XDG_DATA_HOME, "omp", "profiles", "work", "sessions"));
		expect(getPythonGatewayDir()).toBe(
			path.join(process.env.XDG_STATE_HOME, "omp", "profiles", "work", "python-gateway"),
		);
	});

	it("does not silently switch a named profile to XDG once the base app dir appears", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_DATA_HOME = path.join(tempRoot, "data");
		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");

		// Fresh install: XDG vars are set (typical Linux) but no $XDG/omp exists yet.
		// First activation must land in ~/<config-dir>/profiles/work because
		// the profile-specific XDG path does not exist.
		setProfile("work");
		const firstAgentDir = getAgentDir();
		expect(firstAgentDir).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));

		// Later, the base XDG app dir materializes (e.g. via `omp config init-xdg`
		// migrating only the default-profile data). The named profile must stay
		// in its original location until the user explicitly migrates it.
		await fs.mkdir(path.join(process.env.XDG_DATA_HOME, "omp"), { recursive: true });
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, "omp"), { recursive: true });
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, "omp"), { recursive: true });

		setProfile(undefined);
		setProfile("work");
		expect(getAgentDir()).toBe(firstAgentDir);
	});

	it("rejects path-like profile names", () => {
		expect(() => setProfile("../work")).toThrow("Invalid OMP profile");
		expect(() => setProfile("work/team")).toThrow("Invalid OMP profile");
	});

	it("restores the pre-profile PI_CODING_AGENT_DIR override on reset", () => {
		const customAgentDir = path.join(tempRoot, "custom-agent");
		setAgentDir(customAgentDir);
		expect(getAgentDir()).toBe(customAgentDir);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(customAgentDir);

		setProfile("work");
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).not.toBe(customAgentDir);

		setProfile(undefined);
		expect(getActiveProfile()).toBeUndefined();
		// Critical: reset must restore the user's override, not delete it.
		expect(process.env.PI_CODING_AGENT_DIR).toBe(customAgentDir);
		expect(getAgentDir()).toBe(customAgentDir);
	});

	it("clears PI_CODING_AGENT_DIR on reset when nothing was set originally", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		// Force a baseline snapshot of "no override" via setProfile so a stale
		// module-load snapshot from a previous test cannot leak in.
		setProfile("work");
		setProfile(undefined);
		expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
	});

	it("rejects Windows reserved device names case-insensitively", () => {
		for (const name of ["CON", "con", "PRN", "AUX", "NUL", "COM0", "COM9", "lpt1", "LPT9", "CON.txt", "com1.bak"]) {
			expect(() => setProfile(name)).toThrow("Windows reserved device name");
		}
	});

	it("does not restore a profile-derived agent dir as the default baseline", () => {
		// Reproduces a child process that inherited OMP_PROFILE=work plus the
		// profile-derived PI_CODING_AGENT_DIR that setProfile propagates to
		// children. The module-load snapshot must not capture that profile dir as
		// the default baseline, or setProfile(undefined) would resolve default
		// mode into the work profile's agent dir.
		setProfile("work");
		const workAgentDir = path.join(os.homedir(), configDir, "profiles", "work", "agent");
		expect(getAgentDir()).toBe(workAgentDir);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(workAgentDir);

		// Re-snapshot exactly as module load would, now that OMP_PROFILE and the
		// profile-derived PI_CODING_AGENT_DIR are present in the environment.
		__resetProfileSnapshotForTests();

		setProfile(undefined);
		expect(getActiveProfile()).toBeUndefined();
		expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "agent"));
	});
});
