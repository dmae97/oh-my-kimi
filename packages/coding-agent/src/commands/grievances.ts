/**
 * View recently reported tool issues from automated QA.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { listGrievances } from "../cli/grievances-cli";

export default class Grievances extends Command {
	static description = "View reported tool issues (auto-QA grievances)";

	static flags = {
		limit: Flags.integer({ char: "n", description: "Number of recent issues to show", default: 20 }),
		tool: Flags.string({ char: "t", description: "Filter by tool name" }),
		json: Flags.boolean({ char: "j", description: "Output as JSON", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Grievances);
		await listGrievances({ limit: flags.limit, tool: flags.tool, json: flags.json });
	}
}
