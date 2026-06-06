/**
 * Render every built-in tool's renderer across its lifecycle states.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { GALLERY_STATES, type GalleryState, runGalleryCommand } from "../cli/gallery-cli";

export default class Gallery extends Command {
	static description = "Preview tool renderers across streaming, in-progress, success, and failure states";

	static flags = {
		tool: Flags.string({ char: "t", description: "Render a single tool by name" }),
		state: Flags.string({
			char: "s",
			description: "Render only the given lifecycle state(s)",
			options: [...GALLERY_STATES],
			multiple: true,
		}),
		width: Flags.integer({ char: "w", description: "Render width in columns" }),
		expanded: Flags.boolean({
			char: "e",
			description: "Render the expanded variant of each renderer",
			default: false,
		}),
		plain: Flags.boolean({ description: "Strip ANSI styling from the output", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gallery);
		await runGalleryCommand({
			tool: flags.tool,
			states: flags.state as GalleryState[] | undefined,
			width: flags.width,
			expanded: flags.expanded,
			plain: flags.plain,
		});
	}
}
