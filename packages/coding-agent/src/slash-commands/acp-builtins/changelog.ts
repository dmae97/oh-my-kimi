import { getChangelogPath, parseChangelog } from "../../utils/changelog";
import { commandConsumed } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const changelogCommand: AcpBuiltinCommandSpec = {
	name: "changelog",
	description: "Show changelog",
	inputHint: "[full]",
	handle: async (command, runtime) => {
		const changelogPath = getChangelogPath();
		const allEntries = await parseChangelog(changelogPath);
		const showFull = command.args.trim().toLowerCase() === "full";
		const entriesToShow = showFull ? allEntries : allEntries.slice(0, 3);
		if (entriesToShow.length === 0) {
			await runtime.output("No changelog entries found.");
			return commandConsumed();
		}
		await runtime.output(
			[...entriesToShow]
				.reverse()
				.map(entry => entry.content)
				.join("\n\n"),
		);
		return commandConsumed();
	},
};
