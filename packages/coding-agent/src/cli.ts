#!/usr/bin/env bun
import { APP_NAME, MIN_BUN_VERSION, procmgr, VERSION } from "@oh-my-pi/pi-utils";

// Strip macOS malloc-stack-logging env vars before any subprocess is spawned.
// Otherwise every child bun process (subagents, plugin installs, ptree spawns,
// etc.) prints a `MallocStackLogging: can't turn off …` warning to stderr.
procmgr.scrubProcessEnv();

/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import { type CliConfig, run } from "@oh-my-pi/pi-utils/cli";
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
 * Smoke-test entry. Spawns the stats sync worker, pings it, exits.
 *
 * Purpose: catch the silent worker-load regressions that hit compiled
 * binaries (issues #1011 and #1027). Neither `--version` nor
 * `stats --summary` actually spawns a Worker on a fresh install — the
 * sync path early-returns when no session files exist. This probe is the
 * minimal end-to-end test that proves `new Worker(...)` resolves and the
 * bundled worker module evaluates successfully. Wired into
 * `scripts/install-tests/run-ci.sh` so binary / source-link / tarball
 * installs all exercise it on every CI run.
 */
async function runSmokeTest(): Promise<void> {
	const { smokeTestSyncWorker } = await import("@oh-my-pi/omp-stats");
	await smokeTestSyncWorker();
	process.stdout.write("smoke-test: ok\n");
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	if (argv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
	// --help and --version are handled by run() directly, don't rewrite those.
	// Everything else that isn't a known subcommand routes to "launch".
	const first = argv[0];
	const runArgv =
		first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help"
			? argv
			: isSubcommand(first)
				? argv
				: ["launch", ...argv];
	return run({ bin: APP_NAME, version: VERSION, argv: runArgv, commands, help: showHelp });
}

await runCli(process.argv.slice(2));
