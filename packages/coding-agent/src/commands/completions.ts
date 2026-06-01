/**
 * `omp completions <bash|zsh|fish>` — print a shell completion script.
 *
 * The script is derived entirely from the declarative command/flag metadata
 * (see `cli/completion-gen.ts`), so it never drifts from the actual CLI surface.
 */
import { APP_NAME, VERSION } from "@oh-my-pi/pi-utils";
import { Args, type CliConfig, Command, type CommandCtor } from "@oh-my-pi/pi-utils/cli";
import { buildSpec, generateCompletion, type Shell } from "../cli/completion-gen";
import { commands } from "../cli-commands";

/** Entry name of the default command whose flags become top-level completions. */
const ROOT_COMMAND = "launch";
const SHELLS = ["bash", "zsh", "fish"] as const;

export default class Completions extends Command {
	static description = "Print a shell completion script (bash, zsh, or fish)";

	static args = {
		shell: Args.string({
			description: "Target shell",
			required: true,
			options: SHELLS,
		}),
	};

	static examples = [
		`# zsh — eval at startup, or write to a file in $fpath\n  eval "$(${APP_NAME} completions zsh)"`,
		`# bash\n  eval "$(${APP_NAME} completions bash)"`,
		`# fish\n  ${APP_NAME} completions fish > ~/.config/fish/completions/${APP_NAME}.fish`,
	];

	async run(): Promise<void> {
		const shell = this.argv[0];
		if (!isShell(shell)) {
			process.stderr.write(`Usage: ${APP_NAME} completions <${SHELLS.join("|")}>\n`);
			process.exitCode = 1;
			return;
		}

		// Load every command class so we can read its static flag/arg descriptors,
		// and collect aliases from both the registration table and the class.
		const loaded = await Promise.all(commands.map(async entry => ({ entry, Cmd: await entry.load() })));
		const map = new Map<string, CommandCtor>();
		const aliasMap = new Map<string, readonly string[]>();
		for (const { entry, Cmd } of loaded) {
			map.set(entry.name, Cmd);
			const merged = new Set<string>([...(Cmd.aliases ?? []), ...(entry.aliases ?? [])]);
			aliasMap.set(entry.name, [...merged]);
		}

		const config: CliConfig = { bin: APP_NAME, version: VERSION, commands: map };
		const spec = buildSpec(config, ROOT_COMMAND, aliasMap);
		process.stdout.write(generateCompletion(shell, spec));
	}
}

function isShell(value: string | undefined): value is Shell {
	return value === "bash" || value === "zsh" || value === "fish";
}
