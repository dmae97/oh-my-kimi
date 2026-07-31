import { describe, expect, it } from "vitest";
import { OMK_GITHUB_REPOSITORY_URL } from "../src/core/github-repository.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("GitHub repository command", () => {
	it("keeps repository access opt-in and discoverable", () => {
		expect(OMK_GITHUB_REPOSITORY_URL).toBe("https://github.com/dmae97/omk");
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "star",
			description: "Open the OMK GitHub repository",
		});
	});
});
