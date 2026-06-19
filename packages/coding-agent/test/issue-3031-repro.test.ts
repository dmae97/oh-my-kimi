/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/3031
 *
 * Mnemopi's local embedding provider used to `import("onnxruntime-node")` and
 * `import("fastembed")` directly inside `fastembed-runtime.ts`. With
 * `memory.backend: mnemopi` enabled on Windows that crashed Bun in two ways:
 *   - Standalone binary: NAPI `process.dlopen` constructor segfault at
 *     session start, before any prompt rendered.
 *   - NPM install: NAPI finalizer segfault at process teardown.
 *
 * The fix relocates the embeddings stack into a Bun.spawn child process. The
 * agent's main process hands `mnemopi.setLocalModelInitializer` a wrapper that
 * round-trips through `__omp_worker_mnemopi_embed`, and `SIGKILL`s the child
 * on dispose so the destructor never runs in either address space. These tests
 * pin the three pieces of that contract so a future refactor cannot quietly
 * re-introduce the crash.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createMnemopiEmbedSubprocess, MNEMOPI_EMBED_WORKER_ARG } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";

describe("issue #3031 — mnemopi embeddings live in an isolated subprocess", () => {
	it("ping/pongs through the spawned worker subprocess and tears it down cleanly", async () => {
		// `smokeTestMnemopiEmbedWorker` is the runtime probe wired into
		// `omp --smoke-test`. Run it in a child Bun process instead of this
		// Bun-test worker: the test runner owns its own IPC channel and can
		// starve nested Bun subprocess IPC on some Bun builds.
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const script =
			'const { smokeTestMnemopiEmbedWorker } = await import("@oh-my-pi/pi-coding-agent/mnemopi/embed-client"); await smokeTestMnemopiEmbedWorker({ timeoutMs: 15000 });';
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(`${stdout}${stderr}`).toBe("");
		expect(exitCode).toBe(0);
	}, 30_000);

	it("CLI dispatches the flag that `embed-client.ts` passes to the spawned child", async () => {
		// `mnemopiEmbedWorkerSpawnCmd()` and the cli switch must agree on the
		// exact flag, character-for-character — the spawned `bun`/binary sees
		// only `argv` and there is no fallback path that "re-routes" the
		// worker on misnamed flags. Pin the spelling on both ends.
		const cliSource = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text();
		expect(cliSource).toContain(`"${MNEMOPI_EMBED_WORKER_ARG}"`);
		expect(cliSource).toContain("startMnemopiEmbedWorker");
	});

	it("surfaces unexpected signal exits so in-flight callers don't await forever", async () => {
		// If the child dies from a signal we did NOT request — SIGSEGV from
		// onnxruntime's NAPI fault (the original Windows shutdown bug, now
		// relocated to the child), an OOM SIGKILL, or an operator `kill -9`
		// — the subprocess wrapper must fault every in-flight request via
		// the `errors` channel. Without this contract a `TinyTitleClient`-
		// style swallow would leave callers waiting forever on `await embed`.
		const sub = createMnemopiEmbedSubprocess();
		try {
			const { promise, resolve } = Promise.withResolvers<Error>();
			sub.errors.add(resolve);
			sub.proc.kill("SIGKILL");
			const err = await promise;
			expect(err.message).toMatch(/signal/i);
		} finally {
			try {
				sub.proc.kill("SIGKILL");
			} catch {}
			await sub.proc.exited;
		}
	}, 15_000);

	it("does not surface intentional terminate() SIGKILLs as worker errors", async () => {
		// Inverse of the previous test: a SIGKILL issued by the wrapper's
		// own `terminate()` MUST NOT fault callers — terminate is the
		// shutdown path and the worker handle is already torn down by then.
		// Regression guard against an over-eager fix that surfaces every
		// signal exit indiscriminately.
		const sub = createMnemopiEmbedSubprocess();
		let errored = false;
		sub.errors.add(() => {
			errored = true;
		});
		// Simulate what `wrapSubprocess.terminate()` does: flip the flag,
		// then SIGKILL. We test the primitive directly rather than going
		// through the wrapper to avoid coupling to `WorkerHandle` internals.
		// `proc.exited` resolves only after the `onExit` handler runs, so by
		// the time the await returns the error channel reflects the truth —
		// no real-clock sleep needed.
		sub.intentionalExit.value = true;
		sub.proc.kill("SIGKILL");
		await sub.proc.exited;
		expect(errored).toBe(false);
	}, 10_000);

	it("does not import fastembed-runtime from the main agent module graph", async () => {
		// Issue #3031 caused: `mnemopi/state.ts` (or anything it transitively
		// loaded) statically importing `core/fastembed-runtime`, which loads
		// `onnxruntime-node` natively. Only the dedicated worker module is
		// allowed to reach into that runtime. Scan the agent's mnemopi shim
		// surface and the session entrypoint to lock the rule in.
		const candidates = [
			"../src/mnemopi/state.ts",
			"../src/mnemopi/backend.ts",
			"../src/mnemopi/embed-client.ts",
			"../src/mnemopi/embed-protocol.ts",
			"../src/session/agent-session.ts",
			"../src/cli.ts",
		];
		for (const rel of candidates) {
			const source = await Bun.file(new URL(rel, import.meta.url)).text();
			expect(source).not.toContain("fastembed-runtime");
			expect(source).not.toContain('"fastembed"');
			expect(source).not.toContain('"onnxruntime-node"');
		}
	});
});
