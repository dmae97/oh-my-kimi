import { afterEach, describe, expect, it, vi } from "bun:test";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

function createTextStream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) throw new Error("Failed to create response stream.");
	return body;
}

function createFakeProcess(stdout = "", stderr = "", exitCode = 0, exited?: Promise<number>): Subprocess {
	return {
		pid: 12345,
		stdout: createTextStream(stdout),
		stderr: createTextStream(stderr),
		exited: exited ?? Promise.resolve(exitCode),
		kill: vi.fn(),
	} as unknown as Subprocess;
}

function createSpawnMock(factory: () => Subprocess, calls?: SpawnOptions[]) {
	function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], options?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		if (calls) {
			if (Array.isArray(first)) {
				calls.push(second ?? {});
			} else {
				const { cmd, ...options } = first;
				void cmd;
				calls.push(options);
			}
		}
		return factory();
	}

	return mockSpawn;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("git subprocess safety", () => {
	it("passes non-interactive credential env to git", async () => {
		const calls: SpawnOptions[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(() => createFakeProcess(), calls));

		await git.push("/work/pi");

		expect(calls[0]?.env?.GIT_TERMINAL_PROMPT).toBe("0");
		expect(calls[0]?.env?.GIT_ASKPASS).toBeDefined();
		expect(calls[0]?.env?.SSH_ASKPASS).toBeDefined();
		expect(calls[0]?.env?.GPG_TTY).toBe("not a tty");
	});

	it("bounds captured stdout", async () => {
		const tooLarge = "x".repeat(git.GIT_COMMAND_OUTPUT_LIMIT_BYTES + 1);
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(() => createFakeProcess(tooLarge)));

		const output = await git.show("/work/pi", "HEAD");

		expect(output.length).toBeLessThanOrEqual(git.GIT_COMMAND_OUTPUT_LIMIT_BYTES + 200);
		expect(output).toContain("truncated");
	});

	it("kills git commands that exceed the subprocess timeout", async () => {
		vi.useFakeTimers();
		const child = createFakeProcess("", "", 0, new Promise<number>(() => {}));
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(() => child));

		const failure = git.push("/work/pi").then(
			() => undefined,
			error => error,
		);
		vi.advanceTimersByTime(git.GIT_COMMAND_TIMEOUT_MS);
		await flushMicrotasks();
		const error = await failure;

		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(error).toBeInstanceOf(git.GitCommandError);
		expect(String(error.message)).toContain("timed out");
	});
});
