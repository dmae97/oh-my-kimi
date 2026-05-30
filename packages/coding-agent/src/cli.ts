#!/usr/bin/env bun
import {
	APP_NAME,
	getActiveProfile,
	MIN_BUN_VERSION,
	normalizeProfileName,
	setProfile,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";

// Strip macOS malloc-stack-logging env vars before any subprocess is spawned.
// Keep this local instead of importing `@oh-my-pi/pi-utils/procmgr`: that module
// imports `env.ts`, whose eager .env load must happen after `--profile` bootstrap.
delete process.env.MallocStackLogging;
delete process.env.MallocStackLoggingNoCompact;

/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import { type CliConfig, run } from "@oh-my-pi/pi-utils/cli";
import { installProfileAlias } from "./cli/profile-alias";
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
	let resolvedArgv = argv;
	try {
		const extracted = extractProfileFlags(resolvedArgv);
		resolvedArgv = extracted.argv;
		if (extracted.profile !== undefined) {
			setProfile(extracted.profile);
		} else {
			// No explicit --profile: re-validate any OMP_PROFILE/PI_PROFILE inherited
			// from the environment. Module-load resolution deliberately swallows an
			// invalid value to avoid an uncaught throw before this try/catch is in
			// scope (see `readProfileFromEnvSafe` in dirs.ts). Surfacing it here turns
			// `OMP_PROFILE=.. omp --version` into a clean error instead of a stack trace.
			normalizeProfileName(process.env.OMP_PROFILE || process.env.PI_PROFILE);
		}
		if (extracted.aliasName !== undefined) {
			const profile = extracted.profile ?? getActiveProfile();
			if (!profile) {
				throw new Error("--alias requires --profile <name> or OMP_PROFILE");
			}
			const result = await installProfileAlias({ profile, aliasName: extracted.aliasName });
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
