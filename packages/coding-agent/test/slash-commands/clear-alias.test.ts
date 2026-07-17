import { describe, expect, it } from "bun:test";
import {
	BUILTIN_SLASH_COMMANDS,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";

describe("/clear slash command alias", () => {
	it("ranks the new-session action above fuzzy description matches", async () => {
		const provider = new CombinedAutocompleteProvider(
			[...BUILTIN_SLASH_COMMANDS, { name: "autoresearch", description: "Clear stale research results" }],
			process.cwd(),
		);

		const suggestions = await provider.getSuggestions(["/clear"], 0, 6);

		expect(suggestions?.items[0]).toMatchObject({
			value: "clear",
			description: "Start a new session",
		});
		expect(lookupBuiltinSlashCommand("clear")?.name).toBe("new");
	});
});
