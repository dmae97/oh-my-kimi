/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1606
 *
 * On Windows, `onnxruntime-node`'s NAPI finalizer segfaults Bun during
 * shutdown after `@huggingface/transformers` has loaded a tiny model in a
 * Worker thread. The agent used to host the tiny-model worker as a Worker
 * inside its own process; tearing the worker down ran the native destructor
 * in the parent's address space and crashed the CLI on exit.
 *
 * The fix relocates the worker to a child process: `title-client.ts` spawns
 * `process.execPath … --tiny-worker`, `cli.ts` dispatches that flag into
 * `runTinyWorker`, and the parent `SIGKILL`s the child on dispose so the
 * native finalizer never runs in either address space. These tests pin the
 * three pieces of that contract so a future refactor cannot quietly land
 * the original crash again.
 */
import { describe, expect, it } from "bun:test";
import { smokeTestTinyTitleWorker, TINY_WORKER_ARG } from "../src/tiny/title-client";

describe("issue #1606 — tiny model lives in an isolated subprocess", () => {
	it("ping/pongs through the spawned worker subprocess and tears it down cleanly", async () => {
		// `smokeTestTinyTitleWorker` is the runtime probe wired into
		// `omp --smoke-test`: it spawns the worker subprocess via
		// `Bun.spawn`, sends a ping over the IPC channel, awaits the pong,
		// then SIGKILLs the child. If anyone reverts the worker to an
		// in-process `new Worker(...)` thread or drops the `--tiny-worker`
		// CLI dispatch, the spawn either picks up the wrong entrypoint or
		// the ping never round-trips, and this test fails.
		await expect(smokeTestTinyTitleWorker({ timeoutMs: 15_000 })).resolves.toBeUndefined();
	}, 30_000);

	it("CLI dispatches the flag that `title-client.ts` passes to the spawned child", async () => {
		// `tinyWorkerSpawnCmd()` and the cli switch must agree on the exact
		// flag, character-for-character — the spawned `bun`/binary sees only
		// `argv` and there is no fallback path that "re-routes" the worker
		// on misnamed flags. Pin the spelling on both ends.
		const cliSource = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text();
		expect(cliSource).toContain(`argv[0] === "${TINY_WORKER_ARG}"`);
		expect(cliSource).toContain("runTinyWorker");
	});
});
