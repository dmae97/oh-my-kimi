import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { buildInitialMessage } from "../src/cli/initial-message";

// Regression coverage for extension-registered flags leaking into the initial
// prompt. The CLI parses argv twice: once at startup (before extensions load,
// so their flag set is unknown) and once after the extension runner is ready.
// `buildInitialMessage` must run on the second, extension-aware parse.
describe("extension flags vs initial message", () => {
	const extFlags = new Map<string, { type: "boolean" | "string" }>([
		["spawn-peer", { type: "string" }],
		["headless", { type: "boolean" }],
	]);

	it("consumes a string extension flag's value instead of leaking it into messages", () => {
		const parsed = parseArgs(["--spawn-peer", "reviewer", "review the diff"], extFlags);

		expect(parsed.unknownFlags.get("spawn-peer")).toBe("reviewer");
		expect(parsed.messages).toEqual(["review the diff"]);
	});

	it("consumes a boolean extension flag without eating the following message", () => {
		const parsed = parseArgs(["--headless", "do the task"], extFlags);

		expect(parsed.unknownFlags.get("headless")).toBe(true);
		expect(parsed.messages).toEqual(["do the task"]);
	});

	it("builds the initial prompt from the real message, not the flag value, when flags are known", () => {
		const parsed = parseArgs(["--spawn-peer", "reviewer", "review the diff"], extFlags);

		const { initialMessage } = buildInitialMessage({ parsed, stdinContent: "diff-context" });

		expect(initialMessage).toBe("diff-context\nreview the diff");
	});

	it("documents the pre-fix leak: without the flag map the value becomes the first prompt", () => {
		// This is exactly the startup parse: extensions have not loaded, so the
		// flag map is absent. `--spawn-peer` is dropped (it starts with `-`) but
		// its bare value `reviewer` is mis-read as the first positional message.
		// Re-parsing with the extension flag map is what corrects this.
		const parsed = parseArgs(["--spawn-peer", "reviewer", "review the diff"]);

		expect(parsed.messages).toEqual(["reviewer", "review the diff"]);

		const { initialMessage } = buildInitialMessage({ parsed, stdinContent: "diff-context" });
		expect(initialMessage).toBe("diff-context\nreviewer");
	});
	it("does not mutate the input argv, so the same array survives the two-pass parse (PR #1503 review)", () => {
		// Reproduces the --option=value + extension flag combo: parseArgs splices
		// the `=` value into its argv to reuse the `args[++i]` path. If it mutated
		// the caller's array, the second (extension-aware) parse would re-splice
		// and `sonnet` would leak into the prompt before "review the diff".
		const argv = ["--model=sonnet", "--spawn-peer", "reviewer", "review the diff"];
		const snapshot = [...argv];
		// First pass: startup parse, before extensions load.
		parseArgs(argv);
		expect(argv).toEqual(snapshot);
		// Second pass: extension-aware reparse on the same array.
		const reparsed = parseArgs(argv, extFlags);
		expect(reparsed.model).toBe("sonnet");
		expect(reparsed.unknownFlags.get("spawn-peer")).toBe("reviewer");
		expect(reparsed.messages).toEqual(["review the diff"]);
		expect(argv).toEqual(snapshot);
	});
});
