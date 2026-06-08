import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;
type SpawnCall = { cmd: string[]; options: SpawnOptions };

type SpawnSyncOptions = Bun.SpawnOptions.SpawnSyncOptions<"ignore", "pipe", "ignore">;

const existingLinuxPath = "/mnt/c/Users/example/Downloads/session.html";
const windowsPath = "C:\\Users\\example\\Downloads\\session.html";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const ENV_KEYS = ["WSL_DISTRO_NAME", "WSL_INTEROP"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

function fakeProcess(): Subprocess {
	return {
		pid: 1,
		exited: Promise.resolve(0),
		kill: () => true,
	} as unknown as Subprocess;
}

function spySpawn(calls: SpawnCall[]) {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		return fakeProcess();
	}
	return vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
}

function spyWslPath(calls: string[][], output: string, exitCode = 0) {
	const result = {
		stdout: Buffer.from(output),
		stderr: null,
		exitCode,
		success: exitCode === 0,
		resourceUsage: {},
		pid: 1,
	} as unknown as Bun.SyncSubprocess<"pipe", "ignore">;

	function mockSpawnSync(opts: SpawnSyncOptions & { cmd: string[] }): Bun.SyncSubprocess<"pipe", "ignore">;
	function mockSpawnSync(cmd: string[], opts?: SpawnSyncOptions): Bun.SyncSubprocess<"pipe", "ignore">;
	function mockSpawnSync(
		first: string[] | (SpawnSyncOptions & { cmd: string[] }),
	): Bun.SyncSubprocess<"pipe", "ignore"> {
		calls.push(Array.isArray(first) ? first : first.cmd);
		return result;
	}
	return vi.spyOn(Bun, "spawnSync").mockImplementation(mockSpawnSync);
}

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = savedEnv[key];
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
	restorePlatform();
	vi.restoreAllMocks();
});

describe("openPath", () => {
	it("opens existing WSL mount files through wslview with a Windows path", () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "wslview" ? "/usr/bin/wslview" : null));
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === existingLinuxPath);

		const spawnSyncCalls: string[][] = [];
		spyWslPath(spawnSyncCalls, windowsPath);
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath(existingLinuxPath);

		expect(spawnSyncCalls).toEqual([["wslpath", "-w", existingLinuxPath]]);
		expect(spawnCalls.map(call => call.cmd)).toEqual([["wslview", windowsPath]]);
	});

	it("keeps WSL URL opening on xdg-open without path conversion", () => {
		setPlatform("linux");
		process.env.WSL_INTEROP = "/run/WSL/1_interop";
		vi.spyOn(piUtils, "$which").mockReturnValue("/usr/bin/wslview");
		const spawnSyncSpy = vi.spyOn(Bun, "spawnSync");
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath("https://example.com");

		expect(spawnSyncSpy).not.toHaveBeenCalled();
		expect(spawnCalls.map(call => call.cmd)).toEqual([["xdg-open", "https://example.com"]]);
	});

	it("falls back to xdg-open when wslview is unavailable", () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		vi.spyOn(piUtils, "$which").mockReturnValue(null);
		const spawnSyncSpy = vi.spyOn(Bun, "spawnSync");
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath(existingLinuxPath);

		expect(spawnSyncSpy).not.toHaveBeenCalled();
		expect(spawnCalls.map(call => call.cmd)).toEqual([["xdg-open", existingLinuxPath]]);
	});
});
