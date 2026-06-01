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
import { type CliConfig, run } from "@oh-my-pi/pi-utils/cli";
import {
	APP_NAME,
	getActiveProfile,
	MIN_BUN_VERSION,
	resolveProfileEnv,
	setProfile,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";
import { installProfileAlias, resolveProfileAliasCommandFromProcess } from "./cli/profile-alias";
import { extractProfileFlags } from "./cli/profile-bootstrap";
import { commands, isSubcommand } from "./cli-commands";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please upgrade: bun upgrade\n`,
	);
	process.exit(1);
}

process.title = APP_NAME;

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
 * Smoke-test entry. Spawns bundled workers, pings them, exits.
 *
 * Purpose: catch the silent worker-load regressions that hit compiled
 * binaries (issues #1011 and #1027). Version/help paths do not spawn worker
 * modules on a fresh install, so this probe is the minimal end-to-end test
 * that proves `new Worker(...)` resolves and bundled worker modules evaluate.
 * Wired into `scripts/install-tests/run-ci.sh` so binary / source-link /
 * tarball installs all exercise it on every CI run.
 */
async function runSmokeTest(): Promise<void> {
	const { smokeTestSyncWorker } = await import("@oh-my-pi/omp-stats");
	const { smokeTestTinyTitleWorker } = await import("./tiny/title-client");
	await smokeTestSyncWorker();
	await smokeTestTinyTitleWorker();
	process.stdout.write("smoke-test: ok\n");
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
	// Parent went away (crashed, SIGKILL, etc.) — commit suicide so we don't
	// linger as an orphan. SIGKILL via `process.kill` keeps us symmetrical
	// with the parent's hard-kill on shutdown: skip every JS/native finalizer.
	process.on("disconnect", () => shutdown());
	await shuttingDown;
	process.kill(process.pid, "SIGKILL");
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

	if (resolvedArgv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
	if (argv[0] === "--tiny-worker") {
		await runTinyWorker();
		return;
	}
	// --help and --version are handled by run() directly, don't rewrite those.
	// Everything else that isn't a known subcommand routes to "launch".
	const first = resolvedArgv[0];
	const runArgv =
		first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help"
			? resolvedArgv
			: isSubcommand(first)
				? resolvedArgv
				: ["launch", ...resolvedArgv];
	return run({ bin: APP_NAME, version: VERSION, argv: runArgv, commands, help: showHelp });
}

if (import.meta.main) {
	await runCli(process.argv.slice(2));
}
