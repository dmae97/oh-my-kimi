import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { containsWorkflow, highlightWorkflow, WORKFLOW_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/workflow";

beforeAll(() => {
	// highlightWorkflow reads the global theme's color mode.
	initTheme();
});

describe("workflow keyword detection", () => {
	it("matches the lowercase trigger word delimited by whitespace", () => {
		expect(containsWorkflow("workflowz")).toBe(true);
		expect(containsWorkflow("please workflowz this rollout")).toBe(true);
		expect(containsWorkflow("design the workflowz")).toBe(true);
		expect(containsWorkflow("run these workflowz")).toBe(true);
	});

	it("ignores old triggers, casing, inflections, punctuation-adjacent, and path-embedded forms", () => {
		expect(containsWorkflow("workflow")).toBe(false);
		expect(containsWorkflow("workflows")).toBe(false);
		expect(containsWorkflow("Workflowz")).toBe(false);
		expect(containsWorkflow("WORKFLOWZ")).toBe(false);
		expect(containsWorkflow("workflowzed the build")).toBe(false);
		expect(containsWorkflow("reworkflowz everything")).toBe(false);
		// A path/extension is not whitespace, so the word never triggers.
		expect(containsWorkflow("packages/coding-agent/test/modes/workflowz.test.ts")).toBe(false);
		expect(containsWorkflow("do it. workflowz.")).toBe(false);
		expect(containsWorkflow("nothing to see here")).toBe(false);
	});
});

describe("workflow keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const input = "please workflowz this";
		const decorated = highlightWorkflow(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		// Probe hits the substring but the whitespace boundary fails — no decoration.
		expect(highlightWorkflow("workflowzed builds")).toBe("workflowzed builds");
		expect(highlightWorkflow("Workflowz this")).toBe("Workflowz this");
		const filePath = "packages/coding-agent/test/modes/workflowz.test.ts";
		expect(highlightWorkflow(filePath)).toBe(filePath);
	});
});

describe("workflow notice", () => {
	it("is a non-empty system notice carrying the eval-fan-out contract", () => {
		expect(WORKFLOW_NOTICE.length).toBeGreaterThan(0);
		expect(WORKFLOW_NOTICE).toContain("**workflowz** keyword");
		expect(WORKFLOW_NOTICE).toContain("parallel(");
	});
});
