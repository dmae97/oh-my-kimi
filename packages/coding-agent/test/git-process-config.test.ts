import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Subprocess } from "bun";
import * as git from "../src/utils/git";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = {
	cmd: string[];
	options: SpawnOptions;
};

function createTextStream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) {
		throw new Error("Failed to create response stream.");
	}
	return body;
}

function createFakeProcess(stdout = "", stderr = "", exitCode = 0): Subprocess {
	return {
		pid: 12345,
		stdout: createTextStream(stdout),
		stderr: createTextStream(stderr),
		exited: Promise.resolve(exitCode),
	} as Subprocess;
}

function createSpawnMock(calls: SpawnCall[]) {
	function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], options?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		if (Array.isArray(first)) {
			calls.push({ cmd: first, options: second ?? ({} as SpawnOptions) });
		} else {
			const { cmd, ...options } = first;
			calls.push({ cmd, options });
		}
		return createFakeProcess();
	}

	return mockSpawn;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("git subprocess config", () => {
	it("disables fsmonitor and untracked cache for read-only commands", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		expect(await git.status.summary("/work/pi")).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cmd).toEqual([
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"--no-optional-locks",
			"status",
			"--porcelain",
		]);
	});

	it("disables fsmonitor and untracked cache for mutating commands", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		await git.stage.files("/work/pi", ["tracked.txt"]);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cmd).toEqual([
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"add",
			"--",
			"tracked.txt",
		]);
	});
});
