import { describe, expect, it } from "bun:test";
import { KeybindingsManager as AppKeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { getGithubRefPrefix, getGithubRefSuggestions } from "@oh-my-pi/pi-coding-agent/modes/github-ref-autocomplete";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-coding-agent/modes/prompt-action-autocomplete";

function makeProvider() {
	return createPromptActionAutocompleteProvider({
		commands: [],
		basePath: "/tmp",
		keybindings: AppKeybindingsManager.inMemory({}),
		copyCurrentLine: () => {},
		copyPrompt: () => {},
		undo: () => {},
		moveCursorToMessageEnd: () => {},
		moveCursorToMessageStart: () => {},
		moveCursorToLineStart: () => {},
		moveCursorToLineEnd: () => {},
	});
}

describe("github-ref autocomplete — prefix detection", () => {
	it("matches the last #<digits> token ending at the cursor", () => {
		expect(getGithubRefPrefix("#3164")).toBe("#3164");
		expect(getGithubRefPrefix("look at #3164")).toBe("#3164");
		expect(getGithubRefPrefix("see #1 and #3164")).toBe("#3164");
	});

	it("does not match bare #, text, or mixed tokens", () => {
		expect(getGithubRefPrefix("#")).toBeNull();
		expect(getGithubRefPrefix("#copy")).toBeNull();
		expect(getGithubRefPrefix("#3164abc")).toBeNull();
		expect(getGithubRefPrefix("#3a")).toBeNull();
		// zero / leading zeros are not valid GitHub numbers
		expect(getGithubRefPrefix("#0")).toBeNull();
		expect(getGithubRefPrefix("#00")).toBeNull();
		expect(getGithubRefPrefix("#0123")).toBeNull();
		// a space after the digits closes the token
		expect(getGithubRefPrefix("#3164 ")).toBeNull();
		expect(getGithubRefPrefix("no hash here")).toBeNull();
	});
});

describe("github-ref autocomplete — suggestions", () => {
	it("offers a PR and an Issue candidate for #<number>", () => {
		const result = getGithubRefSuggestions("#3164");
		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("#3164");
		expect(result!.items).toEqual([
			{ value: "pr://3164", label: "PR #3164", description: "GitHub pull request" },
			{ value: "issue://3164", label: "Issue #3164", description: "GitHub issue" },
		]);
	});

	it("returns null for non-numeric tokens", () => {
		expect(getGithubRefSuggestions("#copy")).toBeNull();
		expect(getGithubRefSuggestions("#")).toBeNull();
		expect(getGithubRefSuggestions("#3164abc")).toBeNull();
		expect(getGithubRefSuggestions("#0")).toBeNull();
	});
});

describe("github-ref autocomplete — provider integration", () => {
	it("yields the ref candidates and rewrites the token to the chosen internal URL", async () => {
		const provider = makeProvider();
		const suggestions = await provider.getSuggestions(["review #3164"], 0, 12);
		expect(suggestions).not.toBeNull();
		expect(suggestions!.prefix).toBe("#3164");
		expect(suggestions!.items.map(item => item.value)).toEqual(["pr://3164", "issue://3164"]);

		const pr = suggestions!.items[0]!;
		const issue = suggestions!.items[1]!;

		const prResult = provider.applyCompletion(["review #3164"], 0, 12, pr, suggestions!.prefix);
		expect(prResult.lines).toEqual(["review pr://3164 "]);
		expect(prResult.cursorCol).toBe("review pr://3164 ".length);

		const issueResult = provider.applyCompletion(["review #3164"], 0, 12, issue, suggestions!.prefix);
		expect(issueResult.lines).toEqual(["review issue://3164 "]);
	});

	it("leaves #<text> and bare # to the prompt-action menu (no github-ref candidates)", async () => {
		const provider = makeProvider();
		const isRef = (value: string) => value.startsWith("pr://") || value.startsWith("issue://");

		const textSuggestions = await provider.getSuggestions(["#copy"], 0, 5);
		expect(textSuggestions?.items.every(item => !isRef(item.value))).toBe(true);

		const bareSuggestions = await provider.getSuggestions(["#"], 0, 1);
		expect(bareSuggestions?.items.every(item => !isRef(item.value))).toBe(true);
	});
});
