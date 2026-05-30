import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runTinyModelsCommand, type TinyModelsAction, type TinyModelsCommandArgs } from "../cli/tiny-models-cli";

const ACTIONS: TinyModelsAction[] = ["download", "list"];

export default class TinyModels extends Command {
	static description = "Download tiny local models (session titles + memory)";

	static args = {
		action: Args.string({
			description: "Action to perform",
			required: false,
			options: ACTIONS,
		}),
		model: Args.string({
			description: "Model key, or all",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(TinyModels);
		const command: TinyModelsCommandArgs = {
			action: (args.action ?? "download") as TinyModelsAction,
			model: args.model,
			flags: {
				json: flags.json,
			},
		};
		await runTinyModelsCommand(command);
	}
}
