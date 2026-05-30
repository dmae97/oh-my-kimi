import { beforeAll, describe, expect, it } from "bun:test";
import { containsOrchestrate, highlightOrchestrate, ORCHESTRATE_NOTICE } from "../../src/modes/orchestrate";
import { initTheme } from "../../src/modes/theme/theme";
import { containsUltrathink, highlightUltrathink } from "../../src/modes/ultrathink";
import { clearBundledCommandsCache, loadBundledCommands } from "../../src/task/commands";

beforeAll(() => {
	// highlightOrchestrate/highlightUltrathink read the global theme's color mode.
	initTheme();
});

describe("orchestrate keyword detection", () => {
	it("matches the standalone word in any case", () => {
		expect(containsOrchestrate("orchestrate")).toBe(true);
		expect(containsOrchestrate("Orchestrate")).toBe(true);
		expect(containsOrchestrate("ORCHESTRATE")).toBe(true);
		expect(containsOrchestrate("please orchestrate this rollout")).toBe(true);
		expect(containsOrchestrate("do it. orchestrate.")).toBe(true);
	});

	it("ignores inflected forms and embedded substrings", () => {
		expect(containsOrchestrate("orchestrated the build")).toBe(false);
		expect(containsOrchestrate("orchestrating now")).toBe(false);
		expect(containsOrchestrate("a clean orchestration")).toBe(false);
		expect(containsOrchestrate("it orchestrates well")).toBe(false);
		expect(containsOrchestrate("reorchestrate everything")).toBe(false);
		expect(containsOrchestrate("nothing to see here")).toBe(false);
	});
});

describe("orchestrate keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const decorated = highlightOrchestrate("please orchestrate this");
		expect(decorated).not.toBe("please orchestrate this");
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe("please orchestrate this");
	});

	it("leaves text without the standalone keyword untouched", () => {
		expect(highlightOrchestrate("nothing here")).toBe("nothing here");
		// Probe hits the substring but the word boundary fails — no decoration.
		expect(highlightOrchestrate("orchestrated builds")).toBe("orchestrated builds");
	});

	it("does not cross-trigger with the ultrathink highlighter", () => {
		expect(highlightOrchestrate("ultrathink")).toBe("ultrathink");
		expect(highlightUltrathink("orchestrate")).toBe("orchestrate");
		expect(containsUltrathink("orchestrate")).toBe(false);
		expect(containsOrchestrate("ultrathink")).toBe(false);
	});
});

describe("orchestrate notice", () => {
	it("is a self-contained system notice carrying the orchestration contract", () => {
		expect(ORCHESTRATE_NOTICE.startsWith("<system-notice>")).toBe(true);
		expect(ORCHESTRATE_NOTICE.endsWith("</system-notice>")).toBe(true);
		expect(ORCHESTRATE_NOTICE).toContain("orchestrator");
		// The contract must not retain the slash-command input placeholder.
		expect(ORCHESTRATE_NOTICE).not.toContain("$@");
	});
});

describe("orchestrate slash command removal", () => {
	it("is no longer bundled as a slash command", () => {
		clearBundledCommandsCache();
		const names = loadBundledCommands().map(command => command.name);
		expect(names).not.toContain("orchestrate");
		expect(names).toContain("init");
	});
});
