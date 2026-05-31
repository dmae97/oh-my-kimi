import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../../src/modes/theme/theme";
import { containsWorkflow, highlightWorkflow, WORKFLOW_NOTICE } from "../../src/modes/workflow";

beforeAll(() => {
	// highlightWorkflow reads the global theme's color mode.
	initTheme();
});

describe("workflow keyword detection", () => {
	it("matches the standalone word (singular or plural) in any case", () => {
		expect(containsWorkflow("workflow")).toBe(true);
		expect(containsWorkflow("Workflow")).toBe(true);
		expect(containsWorkflow("WORKFLOW")).toBe(true);
		expect(containsWorkflow("please workflow this rollout")).toBe(true);
		expect(containsWorkflow("do it. workflow.")).toBe(true);
		expect(containsWorkflow("run these workflows")).toBe(true);
	});

	it("ignores inflected forms and embedded substrings", () => {
		expect(containsWorkflow("workflowed the build")).toBe(false);
		expect(containsWorkflow("reworkflow everything")).toBe(false);
		expect(containsWorkflow("nothing to see here")).toBe(false);
	});
});

describe("workflow keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const input = "please workflow this";
		const decorated = highlightWorkflow(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		// Probe hits the substring but the word boundary fails — no decoration.
		expect(highlightWorkflow("workflowed builds")).toBe("workflowed builds");
	});
});

describe("workflow notice", () => {
	it("is a non-empty system notice carrying the eval-fan-out contract", () => {
		expect(WORKFLOW_NOTICE.length).toBeGreaterThan(0);
		expect(WORKFLOW_NOTICE).toContain("**workflow** keyword");
		expect(WORKFLOW_NOTICE).toContain("parallel(");
	});
});
