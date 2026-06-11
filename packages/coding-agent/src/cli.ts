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
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import { APP_NAME, MIN_BUN_VERSION, VERSION } from "@oh-my-pi/pi-utils/dirs";
import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/env";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please upgrade: bun upgrade\n`,
	);
	process.exit(1);
}

process.title = APP_NAME;

// Declare this module as the worker-host entry: Worker threads and worker
// subprocesses re-enter `Bun.main` with a hidden argv selector instead of
// loading separate worker entrypoints (single-entry contract across source,
// npm bundle, and compiled binary).
declareWorkerHostEntry();

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
	process.stdout.write("smoke-test: ok\n");
}

const TINY_WORKER_ARGS = new Set(["--tiny-worker", "__tiny_worker"]);
const STATS_SYNC_WORKER_ARG = "__omp_stats_sync_worker";
const TAB_WORKER_ARG = "__omp_tab_worker";
const JS_EVAL_WORKER_ARG = "__omp_js_eval_worker";

async function runWorkerEntrypoint(arg: string | undefined): Promise<boolean> {
	if (arg === STATS_SYNC_WORKER_ARG) {
		// The sync worker handles messages via `self.onmessage`, assigned during
		// this *async* dynamic import. Bun flushes the worker's initial message
		// buffer when the entry module's top-level evaluation finishes — before
		// this dispatch completes — so anything the parent posted right after
		// spawning (the smoke ping, the first parse request) would be dropped.
		// Park early events and replay them once the module's handler is live.
		// (The tab/eval workers are immune: `parentPort.on("message")` queues
		// until a listener attaches.)
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
	if (arg === TAB_WORKER_ARG) {
		await import("./tools/browser/tab-worker-entry");
		return true;
	}
	if (arg === JS_EVAL_WORKER_ARG) {
		await import("./eval/js/worker-entry");
		return true;
	}
	return false;
}

/**
 * Hidden subcommand that boots the tiny-model worker inside this process
 * over the parent's IPC channel. The agent's main process spawns the same
 * binary with this flag so `onnxruntime-node` (loaded transitively by
 * `@huggingface/transformers`) lives in a child address space. The parent
 * `SIGKILL`s the child on shutdown so the NAPI finalizer never runs in
 * either process — that finalizer segfaults Bun on Windows (issue #1606).
 */
async function runTinyWorker(): Promise<void> {
	const { startTinyTitleWorker } = await import("./tiny/worker");
	const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();
	const send = (message: unknown): void => {
		// `process.send` only exists when spawned with an IPC channel; the
		// parent always spawns us that way. If it's missing, the parent
		// vanished and there's no one to talk to.
		const sender = (process as NodeJS.Process & { send?: (m: unknown) => boolean }).send;
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
	startTinyTitleWorker({
		send,
		onMessage(handler) {
			const wrap = (data: unknown): void => handler(data as never);
			process.on("message", wrap);
			return () => {
				process.off("message", wrap);
			};
		},
	});
	const keepalive = setInterval(() => {}, 2 ** 30);
	// Parent went away (crashed, SIGKILL, etc.) — commit suicide so we don't
	// linger as an orphan. SIGKILL via `process.kill` keeps us symmetrical
	// with the parent's hard-kill on shutdown: skip every JS/native finalizer.
	process.on("disconnect", () => shutdown());
	try {
		await shuttingDown;
	} finally {
		clearInterval(keepalive);
	}
	process.kill(process.pid, "SIGKILL");
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	if (argv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
	if (TINY_WORKER_ARGS.has(argv[0] ?? "")) {
		await runTinyWorker();
		return;
	}
	if (await runWorkerEntrypoint(argv[0])) {
		return;
	}
	const [{ run }, { commands, resolveCliArgv }] = await Promise.all([
		import("@oh-my-pi/pi-utils/cli"),
		import("./cli-commands"),
	]);
	// --help and --version are handled by run() directly, don't rewrite those.
	// Everything else that isn't a known subcommand routes to "launch".
	const resolved = resolveCliArgv(argv);
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
runCli(process.argv.slice(2)).catch((err: unknown) => {
	process.stderr.write(`${Bun.inspect(err, { colors: process.stderr.isTTY === true })}\n`);
	process.exit(1);
});
