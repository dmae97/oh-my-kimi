/**
 * Show what the read tool will return for a given path.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = "Show what the read tool will return for a path or URL";

	static args = {
		path: Args.string({
			description: "Path or URL to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static flags = {
		timeout: Flags.integer({ description: "Request timeout in seconds (URLs only)" }),
	};

	static examples = [
		"omp read src/foo.ts",
		"omp read src/foo.ts:50-100",
		"omp read src/foo.ts:raw",
		"omp read https://example.com",
		"omp read path/to/archive.zip:dir/file.ts",
		"omp read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
			timeout: flags.timeout,
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
