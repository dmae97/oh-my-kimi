/**
 * Show provider usage limits for every authenticated account.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runUsageCommand } from "../cli/usage-cli";

export default class Usage extends Command {
	static description = "Show provider usage limits for every authenticated account";

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output usage reports as JSON", default: false }),
		provider: Flags.string({ char: "p", description: "Only show usage for this provider id (e.g. anthropic)" }),
		redact: Flags.boolean({
			char: "r",
			description: "Redact account emails/ids (shortest unique prefix) for sharing screenshots",
			default: false,
		}),
	};

	static examples = [
		"# Detailed per-account usage breakdown across all providers\n  omp usage",
		"# Only Anthropic accounts\n  omp usage --provider anthropic",
		"# Redact account identifiers for screenshots\n  omp usage --redact",
		"# Machine-readable output\n  omp usage --json",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Usage);
		await runUsageCommand({
			json: flags.json,
			provider: flags.provider,
			redact: flags.redact,
		});
	}
}
