import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runBenchCommand } from "../cli/bench-cli";

export default class Bench extends Command {
	static description =
		"Benchmark models with the same prompt: time-to-first-token and generation throughput (tokens/s)";

	static args = {
		models: Args.string({
			description: "Model selectors (provider/model or fuzzy id, e.g. opus)",
			required: true,
			multiple: true,
		}),
	};

	static flags = {
		runs: Flags.integer({ description: "Requests per model (results are averaged)", default: 1 }),
		"max-tokens": Flags.integer({ description: "Max output tokens per request", default: 512 }),
		prompt: Flags.string({ description: "Custom prompt text (default: bundled bench prompt)" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		"# Compare two models\n  omp bench anthropic/claude-opus-4-5 openai/gpt-5.2",
		"# Fuzzy selectors work\n  omp bench opus sonnet",
		"# Average over 3 runs each\n  omp bench opus gpt-5.2 --runs 3",
		"# Machine-readable output\n  omp bench opus --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Bench);
		await runBenchCommand({
			models: args.models ?? [],
			flags: {
				runs: flags.runs,
				maxTokens: flags["max-tokens"],
				prompt: flags.prompt,
				json: flags.json,
			},
		});
	}
}
