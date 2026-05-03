/**
 * View and clean recently reported tool issues from automated QA.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { cleanGrievances, listGrievances } from "../cli/grievances-cli";

export default class Grievances extends Command {
	static description = "View or clean reported tool issues (auto-QA grievances)";

	static args = {
		// Positional action: "list" (default) or "clean". A positional arg keeps
		// the historical `omp grievances` invocation working unchanged while
		// reusing the same command surface for the new clean sub-action.
		action: Args.string({
			description: "list (default) or clean",
			required: false,
			options: ["list", "clean"],
			default: "list",
		}),
	};

	static flags = {
		limit: Flags.integer({ char: "n", description: "Number of recent issues to show (list)", default: 20 }),
		tool: Flags.string({ char: "t", description: "Filter by tool name (list, clean)" }),
		json: Flags.boolean({ char: "j", description: "Output as JSON", default: false }),
		id: Flags.integer({ description: "Delete a single grievance by id (clean)" }),
		all: Flags.boolean({ description: "Delete every grievance (clean)", default: false }),
	};

	static examples = [
		"omp grievances",
		"omp grievances list --tool find",
		"omp grievances clean --id 209",
		"omp grievances clean --tool find",
		"omp grievances clean --all",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Grievances);
		if (args.action === "clean") {
			await cleanGrievances({ id: flags.id, tool: flags.tool, all: flags.all, json: flags.json });
			return;
		}
		await listGrievances({ limit: flags.limit, tool: flags.tool, json: flags.json });
	}
}
