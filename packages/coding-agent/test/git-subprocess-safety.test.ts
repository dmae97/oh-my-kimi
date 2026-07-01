import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
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

/** Fake child that never exits on its own — only once `kill` is invoked with `resolveOn`. */
function createTimedOutChild(resolveOn: NodeJS.Signals) {
	const exited = Promise.withResolvers<number>();
	const child = createFakeProcess("", "", 0, exited.promise);
	const kill = vi.fn((signal?: NodeJS.Signals) => {
		if (signal === resolveOn) exited.resolve(1);
		return true;
	});
	child.kill = kill;
	return { child, kill };
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

	it("kills local git commands that exceed the short subprocess deadline before returning", async () => {
		vi.useFakeTimers();
		const { child, kill } = createTimedOutChild("SIGKILL");
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(() => child));

		const failure = git.show("/work/pi", "HEAD").then(
			() => undefined,
			error => error,
		);
		vi.advanceTimersByTime(git.GIT_COMMAND_TIMEOUT_MS);
		await flushMicrotasks();
		expect(kill).toHaveBeenCalledWith("SIGTERM");

		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		const error = await failure;

		expect(kill).toHaveBeenCalledWith("SIGKILL");
		expect(error).toBeInstanceOf(git.GitCommandError);
		expect(String(error.message)).toContain("timed out");
	});

	it("lets fetch outlive the short deadline and kills it at the network deadline", async () => {
		vi.useFakeTimers();
		const { child, kill } = createTimedOutChild("SIGKILL");
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(() => child));

		const failure = git.fetch("/work/pi", "origin", "refs/heads/main", "refs/remotes/origin/main").then(
			() => undefined,
			error => error,
		);

		// The short local-command deadline must not kill a network transfer.
		vi.advanceTimersByTime(git.GIT_COMMAND_TIMEOUT_MS);
		await flushMicrotasks();
		expect(kill).not.toHaveBeenCalled();

		// The wider network deadline still bounds it, with the same
		// SIGTERM → SIGKILL escalation as the short class.
		vi.advanceTimersByTime(git.GIT_NETWORK_TIMEOUT_MS - git.GIT_COMMAND_TIMEOUT_MS);
		await flushMicrotasks();
		expect(kill).toHaveBeenCalledWith("SIGTERM");

		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		const error = await failure;

		expect(kill).toHaveBeenCalledWith("SIGKILL");
		expect(error).toBeInstanceOf(git.GitCommandError);
		expect(String(error.message)).toContain("timed out");
	});

	it("lets clone outlive the short deadline and kills it at the network deadline", async () => {
		vi.useFakeTimers();
		const { child, kill } = createTimedOutChild("SIGTERM");
		const spawned = Promise.withResolvers<void>();
		vi.spyOn(Bun, "spawn").mockImplementation(
			createSpawnMock(() => {
				spawned.resolve();
				return child;
			}),
		);
		const target = path.join(os.tmpdir(), `omp-git-clone-timeout-${crypto.randomUUID()}`);

		const failure = git.clone("https://example.invalid/repo.git", target).then(
			() => undefined,
			error => error,
		);
		// clone does real fs work before spawning; wait for the spawn so the
		// deadline timer is registered before advancing the fake clock.
		await spawned.promise;

		vi.advanceTimersByTime(git.GIT_COMMAND_TIMEOUT_MS);
		await flushMicrotasks();
		expect(kill).not.toHaveBeenCalled();

		vi.advanceTimersByTime(git.GIT_NETWORK_TIMEOUT_MS - git.GIT_COMMAND_TIMEOUT_MS);
		await flushMicrotasks();
		expect(kill).toHaveBeenCalledWith("SIGTERM");

		const error = await failure;
		expect(error).toBeInstanceOf(git.GitCommandError);
		expect(String(error.message)).toContain("timed out");
	});

	it("honors an explicit timeoutMs override on fetch", async () => {
		const { child, kill } = createTimedOutChild("SIGTERM");
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(() => child));

		const error = await git
			.fetch("/work/pi", "origin", "refs/heads/main", "refs/remotes/origin/main", { timeoutMs: 20 })
			.then(
				() => undefined,
				err => err,
			);

		expect(kill).toHaveBeenCalledWith("SIGTERM");
		expect(error).toBeInstanceOf(git.GitCommandError);
		expect(String(error.message)).toContain("timed out after 20ms");
	});

	it("honors an explicit timeoutMs override on clone", async () => {
		const { child, kill } = createTimedOutChild("SIGTERM");
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(() => child));
		const target = path.join(os.tmpdir(), `omp-git-clone-timeout-${crypto.randomUUID()}`);

		const error = await git.clone("https://example.invalid/repo.git", target, { timeoutMs: 20 }).then(
			() => undefined,
			err => err,
		);

		expect(kill).toHaveBeenCalledWith("SIGTERM");
		expect(error).toBeInstanceOf(git.GitCommandError);
		expect(String(error.message)).toContain("timed out after 20ms");
	});
});
