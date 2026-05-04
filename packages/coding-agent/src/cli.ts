#!/usr/bin/env bun
import { APP_NAME, MIN_BUN_VERSION, VERSION } from "@oh-my-pi/pi-utils";
/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import { type CommandEntry, run } from "@oh-my-pi/pi-utils/cli";

function parseSemver(version: string): [number, number, number] {
	function toint(value: string): number {
		const int = Number.parseInt(value, 10);
		if (Number.isNaN(int) || !Number.isFinite(int)) return 0;
		return int;
	}
	const [majorRaw, minorRaw, patchRaw] = version.split(".").map(toint);
	return [majorRaw, minorRaw, patchRaw];
}

function isAtLeastBunVersion(minimum: string): boolean {
	const ver = parseSemver(Bun.version);
	const min = parseSemver(minimum);
	for (let i = 0; i < 3; i++) {
		if (ver[i] !== min[i]) {
			return ver[i] > min[i];
		}
	}
	return true;
}

if (typeof Bun.JSONL?.parseChunk !== "function" || !isAtLeastBunVersion(MIN_BUN_VERSION)) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please update Bun: bun upgrade\n`,
	);
	process.exit(1);
}

// Detect known Bun errata that cause TUI crashes (e.g. Bun.stringWidth mishandling OSC sequences).
if (Bun.stringWidth("\x1b[0m\x1b]8;;\x07") !== 0) {
	process.stderr.write(`error: Bun runtime errata detected (v${Bun.version}). Please update Bun: bun upgrade\n`);
	process.exit(1);
}

process.title = APP_NAME;

const commands: CommandEntry[] = [
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default) },
	{ name: "agents", load: () => import("./commands/agents").then(m => m.default) },
	{ name: "commit", load: () => import("./commands/commit").then(m => m.default) },
	{ name: "config", load: () => import("./commands/config").then(m => m.default) },
	{ name: "grep", load: () => import("./commands/grep").then(m => m.default) },
	{ name: "grievances", load: () => import("./commands/grievances").then(m => m.default) },
	{ name: "jupyter", load: () => import("./commands/jupyter").then(m => m.default) },
	{ name: "plugin", load: () => import("./commands/plugin").then(m => m.default) },
	{ name: "setup", load: () => import("./commands/setup").then(m => m.default) },
	{ name: "shell", load: () => import("./commands/shell").then(m => m.default) },
	{ name: "read", load: () => import("./commands/read").then(m => m.default) },
	{ name: "ssh", load: () => import("./commands/ssh").then(m => m.default) },
	{ name: "stats", load: () => import("./commands/stats").then(m => m.default) },
	{ name: "update", load: () => import("./commands/update").then(m => m.default) },
	{ name: "search", load: () => import("./commands/web-search").then(m => m.default), aliases: ["q"] },
];

async function showHelp(config: import("@oh-my-pi/pi-utils/cli").CliConfig): Promise<void> {
	const { renderRootHelp } = await import("@oh-my-pi/pi-utils/cli");
	const { getExtraHelpText } = await import("./cli/args");
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) {
		process.stdout.write(`\n${extra}\n`);
	}
}

/**
 * Determine whether argv[0] is a known subcommand name.
 * If not, the entire argv is treated as args to the default "launch" command.
 */
function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(e => e.name === first || e.aliases?.includes(first));
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export function runCli(argv: string[]): Promise<void> {
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
