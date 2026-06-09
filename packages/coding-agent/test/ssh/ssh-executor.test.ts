import { afterEach, describe, expect, it, vi } from "bun:test";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { executeSSH } from "@oh-my-pi/pi-coding-agent/ssh/ssh-executor";
import * as sshfsMount from "@oh-my-pi/pi-coding-agent/ssh/sshfs-mount";
import { type ChildProcess, ptree } from "@oh-my-pi/pi-utils";

type TestStdin = "pipe" | "ignore" | Buffer | Uint8Array | null;

function createNeverClosingStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("started\n"));
		},
	});
}

function createBlockedChild<In extends TestStdin>(): ChildProcess<In> {
	const { promise } = Promise.withResolvers<number>();

	return {
		stdout: createNeverClosingStream(),
		stderr: undefined,
		exited: promise,
		[Symbol.dispose]() {},
	} as unknown as ChildProcess<In>;
}

async function flushMicrotasks(count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await Promise.resolve();
	}
}

describe("executeSSH", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns promptly when an abort races a ControlMaster stream that stays open", async () => {
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue();
		vi.spyOn(connectionManager, "buildRemoteCommand").mockResolvedValue(["remote", "sleep 60"]);
		vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>() => createBlockedChild<In>());

		const chunked = Promise.withResolvers<void>();
		const controller = new AbortController();
		const resultPromise = executeSSH({ name: "remote", host: "remote" }, "sleep 60", {
			signal: controller.signal,
			onChunk: () => chunked.resolve(),
		});
		await chunked.promise;

		let result: Awaited<typeof resultPromise> | undefined;
		resultPromise.then(value => {
			result = value;
		});
		controller.abort("user interrupt");
		await flushMicrotasks(20);
		expect(result).toBeDefined();
		if (!result) return;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command aborted");
	});
});
