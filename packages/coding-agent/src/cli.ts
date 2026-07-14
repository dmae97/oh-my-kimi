#!/usr/bin/env bun
// Strip macOS malloc-stack-logging vars in the parent entrypoint, before any
// subprocess/worker spawn. libmalloc reads MallocStackLogging /
// MallocStackLoggingNoCompact during malloc bootstrap (pre-main) in every child
// and warns when they're present but set to "off"; a child cannot suppress its
// own warning, so the only fix is to keep them out of the inherited env here.
// (They must be unset, not set — presence is the trigger.)
try {
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
} catch {}

/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import { parentPort } from "node:worker_threads";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import {
	APP_NAME,
	getActiveProfile,
	MIN_BUN_VERSION,
	resolveProfileEnv,
	setProfile,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";
import { declareWorkerHostEntry, installWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { installProfileAlias, resolveProfileAliasCommandFromProcess } from "./cli/profile-alias";
import { extractProfileFlags } from "./cli/profile-bootstrap";
import { DAEMON_BROKER_WORKER_ARG } from "./launch/protocol";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please upgrade: bun upgrade\n`,
	);
	process.exit(1);
}

process.title = APP_NAME;

// `Bun.build`-API compiled Windows executables report `import.meta.main ===
// false`: the standalone loader keys the entry module with native backslashes
// (`B:\~BUN\root\cli.js`) but registers the main path with forward slashes
// (`B:/~BUN/root/cli.js`), so Bun's internal match fails. `bun build --compile`
// CLI builds are unaffected. A compiled binary's entry module is by definition
// the process entry, so the define-folded PI_COMPILED marker stands in.
const isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true";

// Worker-host entry declaration (Worker threads and worker subprocesses
// re-enter `Bun.main` with a hidden argv selector instead of loading separate
// worker entrypoints) happens inside `runCli` after profile bootstrap:
// `@oh-my-pi/pi-utils/env` eagerly loads `.env` from the agent directory at
// import time, so it must not be imported before `setProfile` runs.

async function showHelp(config: CliConfig): Promise<void> {
	const { renderRootHelp } = await import("@oh-my-pi/pi-utils/cli");
	const { getExtraHelpText } = await import("./cli/args");
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) {
		process.stdout.write(`\n${extra}\n`);
	}
}
/**
 * Smoke-test entry. Spawns bundled workers, serves the stats dashboard once,
 * pings everything, then exits.
 *
 * Purpose: catch the silent worker-load and bundled-asset regressions that hit
 * compiled binaries and the npm CLI bundle. Version/help paths do not spawn
 * worker modules or serve dashboard assets on a fresh install, so this probe is
 * the minimal end-to-end test that proves those distribution-only paths work.
 * Wired into `scripts/install-tests/run-ci.sh` so binary / source-link /
 * tarball installs all exercise it on every CI run.
 */
async function runSmokeTest(): Promise<void> {
	const { smokeTestSyncWorker, startServer } = await import("@oh-my-pi/omp-stats");
	const { smokeTestTinyTitleWorker } = await import("./tiny/title-client");
	const { smokeTestSttWorker } = await import("./stt/asr-client");
	const { smokeTestTtsWorker } = await import("./tts/tts-client");
	const { smokeTestMnemopiEmbedWorker } = await import("./mnemopi/embed-client");
	const { smokeTestJsEvalWorker } = await import("./eval/js/context-manager");
	// Smoke dependencies stay lazy so normal CLI startup does not load worker clients.
	const { smokeTestDaemonBroker } = await import("./launch/client");
	await smokeTestSyncWorker();

	const statsServer = await startServer(0);
	try {
		const response = await fetch(`http://127.0.0.1:${statsServer.port}/`);
		if (!response.ok) throw new Error(`stats dashboard smoke failed: HTTP ${response.status}`);
		const html = await response.text();
		if (!html.includes('<div id="root"></div>') || !html.includes("index.js")) {
			throw new Error("stats dashboard smoke failed: dashboard HTML was not served");
		}
	} finally {
		statsServer.stop();
	}

	await smokeTestTinyTitleWorker();
	await smokeTestSttWorker();
	await smokeTestJsEvalWorker();
	await smokeTestTtsWorker();
	await smokeTestMnemopiEmbedWorker();
	await smokeTestDaemonBroker();
	process.stdout.write("smoke-test: ok\n");
}

const TINY_WORKER_ARG = "__omp_worker_tiny_inference";
const STATS_SYNC_WORKER_ARG = "__omp_worker_stats_sync";
const TAB_WORKER_ARG = "__omp_worker_tab";
const JS_EVAL_WORKER_ARG = "__omp_worker_js_eval";
const STT_WORKER_ARG = "__omp_worker_stt";
const TTS_WORKER_ARG = "__omp_worker_tts";
const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

async function runWorkerEntrypoint(arg: string | undefined): Promise<boolean> {
	if (arg === TINY_WORKER_ARG) {
		await runTinyWorker();
		return true;
	}
	if (arg === STATS_SYNC_WORKER_ARG) {
		// The sync worker handles messages via `self.onmessage`, assigned during
		// this *async* dynamic import. Bun flushes the worker's initial message
		// buffer when the entry module's top-level evaluation finishes — before
		// this dispatch completes — so anything the parent posted right after
		// spawning (the smoke ping, the first parse request) would be dropped.
		// Park early events and replay them once the module's handler is live.
		// Worker-thread entries using `parentPort` need the same sync-prefix
		// buffering; the tab/eval cases install that inbox below before import.
		const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null };
		const pending: MessageEvent[] = [];
		const buffer = (event: MessageEvent): void => {
			pending.push(event);
		};
		scope.onmessage = buffer;
		await import("@oh-my-pi/omp-stats/sync-worker");
		const handler = scope.onmessage;
		if (handler && handler !== buffer) {
			for (const event of pending) handler.call(scope, event);
		}
		return true;
	}
	// Bun flushes messages the parent posted before spawn once this entry's
	// top-level evaluation completes, delivering them only to listeners present
	// at that moment. These worker modules are imported dynamically below, so
	// their own `parentPort.on("message")` lands after the flush and the parent's
	// synchronous `init` is dropped. Install a buffering inbox synchronously here
	// (still inside the entry's sync prefix) so the handshake survives; the worker
	// module binds the real handler once loaded.
	if (arg === TAB_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./tools/browser/tab-worker-entry");
		return true;
	}
	if (arg === JS_EVAL_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./eval/js/worker-entry");
		return true;
	}
	if (arg === STT_WORKER_ARG) {
		const { startSttWorker } = await import("./stt/asr-worker");
		await runIpcSubprocessWorker(startSttWorker);
		return true;
	}
	if (arg === TTS_WORKER_ARG) {
		const { startTtsWorker } = await import("./tts/tts-worker");
		await runIpcSubprocessWorker(startTtsWorker);
		return true;
	}
	if (arg === MNEMOPI_EMBED_WORKER_ARG) {
		const { startMnemopiEmbedWorker } = await import("./mnemopi/embed-worker");
		await runIpcSubprocessWorker(startMnemopiEmbedWorker);
		return true;
	}
	if (arg === DAEMON_BROKER_WORKER_ARG) {
		// Worker selectors must dispatch before the normal command graph loads.
		const { startDaemonBrokerFromEnvironment } = await import("./launch/broker");
		await startDaemonBrokerFromEnvironment();
		return true;
	}
	return false;
}

/**
 * Boot a subprocess-isolated transformers.js worker over the parent's IPC
 * channel and block until the parent disconnects. The tiny-model, STT, and TTS
 * workers each run `onnxruntime-node` (loaded transitively by
 * `@huggingface/transformers`) in a child address space because its NAPI
 * finalizer segfaults Bun on shutdown (issue #1606); the parent `SIGKILL`s the
 * child so that finalizer never runs in either process. This wires `process`
 * IPC to the worker's typed transport, keeps the event loop alive while the
 * worker is idle, and hard-kills the process on parent `disconnect`.
 */
async function runIpcSubprocessWorker<In, Out>(
	start: (transport: {
		send(message: Out): void;
		sendAndFlush(message: Out): Promise<void>;
		onMessage(handler: (message: In) => void): () => void;
	}) => void,
): Promise<void> {
	const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();
	type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;
	// `process.send` only exists when spawned with an IPC channel; the parent
	// always spawns us that way. If it's missing, the parent vanished and
	// there's no one to talk to.
	const ipcSend = (): IpcSend | undefined => (process as NodeJS.Process & { send?: IpcSend }).send;
	const send = (message: Out): void => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return;
		}
		try {
			sender.call(process, message);
		} catch {
			shutdown();
		}
	};
	const sendAndFlush = (message: Out): Promise<void> => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		try {
			sender.call(process, message, () => resolve());
		} catch {
			shutdown();
			resolve();
		}
		return promise;
	};
	start({
		send,
		sendAndFlush,
		onMessage(handler) {
			const wrap = (data: unknown): void => handler(data as In);
			process.on("message", wrap);
			return () => {
				process.off("message", wrap);
			};
		},
	});
	const keepalive = setInterval(() => {}, 2 ** 30);
	// Parent went away (crashed, SIGKILL, etc.) — commit suicide so we don't
	// linger as an orphan. SIGKILL via `process.kill` keeps us symmetrical with
	// the parent's hard-kill on shutdown: skip every JS/native finalizer.
	process.on("disconnect", () => shutdown());
	try {
		await shuttingDown;
	} finally {
		clearInterval(keepalive);
	}
	process.kill(process.pid, "SIGKILL");
}

/**
 * Hidden subcommand that boots the tiny-model worker inside this process over
 * the parent's IPC channel. The agent's main process spawns the same binary
 * with this flag so `onnxruntime-node` (loaded transitively by
 * `@huggingface/transformers`) lives in a child address space. The parent
 * `SIGKILL`s the child on shutdown so the NAPI finalizer never runs in either
 * process — that finalizer segfaults Bun on Windows (issue #1606).
 */
async function runTinyWorker(): Promise<void> {
	const { startTinyTitleWorker } = await import("./tiny/worker");
	await runIpcSubprocessWorker(startTinyTitleWorker);
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	let resolvedArgv = argv;
	try {
		const extracted = extractProfileFlags(resolvedArgv);
		resolvedArgv = extracted.argv;
		if (extracted.profile !== undefined) {
			setProfile(extracted.profile);
		} else {
			// No explicit --profile: activate any OMP_PROFILE/PI_PROFILE inherited
			// from the environment. Module-load resolution deliberately swallows an
			// invalid value to avoid an uncaught throw before this try/catch is in
			// scope (see `readProfileFromEnvSafe` in dirs.ts), and callers may set
			// OMP_PROFILE after importing this module (profile aliases/tests). Surfacing
			// validation here turns `OMP_PROFILE=.. omp --version` into a clean error;
			// calling setProfile keeps every later path helper on the env-selected
			// profile instead of the default agent directory.
			setProfile(resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));
		}
		if (extracted.aliasName !== undefined) {
			const profile = extracted.profile ?? getActiveProfile();
			if (!profile) {
				throw new Error("--alias requires --profile <name> or OMP_PROFILE");
			}
			const result = await installProfileAlias({
				profile,
				aliasName: extracted.aliasName,
				command: resolveProfileAliasCommandFromProcess(),
			});
			process.stdout.write(
				`Created ${result.aliasName} for profile ${result.profile} in ${result.configPath}\n` +
					`Restart your shell or run: ${result.reloadedWith}\n` +
					`Then use: ${result.aliasName} update, ${result.aliasName} --version, or ${result.aliasName}\n`,
			);
			return;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Error: ${message}\n`);
		process.exitCode = 1;
		return;
	}

	// Worker-thread entry dispatch must run before the first `await`: the
	// stats sync worker's buffering onmessage handler is installed in the
	// synchronous prefix of `runWorkerEntrypoint`, and Bun flushes the
	// worker's parked initial messages as soon as the entry module's
	// top-level evaluation finishes.
	if (resolvedArgv[0]?.startsWith("__omp_worker_")) {
		await runWorkerEntrypoint(resolvedArgv[0]);
		return;
	}

	// Declare this module as the worker-host entry now that the active profile
	// is resolved. The worker-host module is side-effect-free; importing
	// `@oh-my-pi/pi-utils/env` here would snapshot the wrong agent `.env`.
	// Gated on `isProcessEntry`: only the real CLI process entry is a valid
	// worker host. Worker-thread re-entry already returned above at the
	// `__omp_worker_` dispatch, and importers (`runCli` in profile-CLI tests,
	// SDK embedding) have `import.meta.main === false` — declaring there would
	// poison `workerHostEntry()` for the whole test process, forcing eval/stats/
	// browser workers onto the same-realm inline fallback.
	if (isProcessEntry) declareWorkerHostEntry();

	if (resolvedArgv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
	const [{ run }, { commands, resolveCliArgv }] = await Promise.all([
		import("@oh-my-pi/pi-utils/cli"),
		import("./cli-commands"),
	]);
	// --help and --version are handled by run() directly, don't rewrite those.
	// Everything else that isn't a known subcommand routes to "launch".
	const resolved = resolveCliArgv(resolvedArgv);
	if ("error" in resolved) {
		process.stderr.write(`error: ${resolved.error}\n`);
		process.exitCode = 1;
		return;
	}
	return run({ bin: APP_NAME, version: VERSION, argv: resolved.argv, commands, help: showHelp });
}

// Floating call instead of top-level await: TLA forces `--bytecode` (CJS
// lowering) builds to fail, and the entrypoint needs nothing after this.
// The catch mirrors what an unhandled TLA rejection produced: error dump to
// stderr, exit code 1. Success paths resolve without touching the exit code.
// Guarded so importing `runCli` (profile CLI tests, SDK embedding) does not
// launch the agent as a side effect. Worker threads re-enter this module as
// their entry with `import.meta.main === false`, so the worker-host dispatch
// is admitted via `!Bun.isMainThread`.
if (isProcessEntry || !Bun.isMainThread) {
	runCli(process.argv.slice(2)).catch((err: unknown) => {
		process.stderr.write(`${Bun.inspect(err, { colors: process.stderr.isTTY === true })}\n`);
		process.exit(1);
	});
}
