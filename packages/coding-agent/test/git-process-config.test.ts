import { afterEach, describe, expect, it, vi } from "bun:test";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import type { Subprocess } from "bun";

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

	it("scopes pushes to the named refspec, never following tags", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		await git.push("/work/pi", { remote: "fork", refspec: "HEAD:refs/heads/feature" });

		// `--no-follow-tags` must override a user's `push.followTags = true`:
		// implicit tag pushes are rejected on remotes the user cannot tag
		// (e.g. PR-head forks) and fail the call after the branch updated.
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cmd).toEqual([
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"push",
			"--no-follow-tags",
			"fork",
			"HEAD:refs/heads/feature",
		]);
	});

	it("preserves the caller's GPG_TTY for signing-capable commands", async () => {
		const originalGpgTty = process.env.GPG_TTY;
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		process.env.GPG_TTY = "/dev/pts/42";
		try {
			await git.commit("/work/pi", "fix: preserve signing tty");
		} finally {
			if (originalGpgTty === undefined) {
				delete process.env.GPG_TTY;
			} else {
				process.env.GPG_TTY = originalGpgTty;
			}
		}

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.options.env?.GPG_TTY).toBe("/dev/pts/42");
	});

	it("does not invent a bogus GPG_TTY when the caller has none", async () => {
		const originalGpgTty = process.env.GPG_TTY;
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		delete process.env.GPG_TTY;
		try {
			await git.commit("/work/pi", "fix: allow gui pinentry");
		} finally {
			if (originalGpgTty !== undefined) {
				process.env.GPG_TTY = originalGpgTty;
			}
		}

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.options.env).not.toHaveProperty("GPG_TTY");
	});
});
