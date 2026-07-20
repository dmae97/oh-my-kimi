import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	containsWorkflow,
	highlightWorkflow,
	renderWorkflowNotice,
	WORKFLOW_NOTICE,
} from "@oh-my-pi/pi-coding-agent/modes/workflow";

beforeAll(() => {
	// highlightWorkflow reads the global theme's color mode.
	initTheme();
});

describe("workflow keyword detection", () => {
	it("matches the lowercase trigger word delimited by whitespace or a string edge", () => {
		expect(containsWorkflow("workflowz")).toBe(true);
		expect(containsWorkflow("please workflowz this rollout")).toBe(true);
		expect(containsWorkflow("design the workflowz")).toBe(true);
		expect(containsWorkflow("run these workflowz")).toBe(true);
	});

	it("matches the lowercase trigger word beside prose punctuation and quotes", () => {
		for (const text of ["do it. workflowz.", "please workflowz, then report", 'say "workflowz" now']) {
			expect(containsWorkflow(text)).toBe(true);
		}
	});

	it("ignores old triggers, casing, inflections, and path-embedded forms", () => {
		expect(containsWorkflow("workflow")).toBe(false);
		expect(containsWorkflow("workflows")).toBe(false);
		expect(containsWorkflow("Workflowz")).toBe(false);
		expect(containsWorkflow("WORKFLOWZ")).toBe(false);
		expect(containsWorkflow("workflowzed the build")).toBe(false);
		expect(containsWorkflow("reworkflowz everything")).toBe(false);
		// A path/extension must not trigger even though sentence punctuation does.
		expect(containsWorkflow("packages/coding-agent/test/modes/workflowz.test.ts")).toBe(false);
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

	it("decorates punctuation-adjacent prose while preserving visible text", () => {
		const input = 'please "workflowz," then continue';
		const decorated = highlightWorkflow(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		// Probe hits the substring but token/path boundaries fail — no decoration.
		expect(highlightWorkflow("workflowzed builds")).toBe("workflowzed builds");
		expect(highlightWorkflow("Workflowz this")).toBe("Workflowz this");
		const filePath = "packages/coding-agent/test/modes/workflowz.test.ts";
		expect(highlightWorkflow(filePath)).toBe(filePath);
	});
});

describe("workflow notice", () => {
	it("renders the Workflowz trigger with eval orchestration helper guidance", () => {
		expect(WORKFLOW_NOTICE).toContain("**workflowz** keyword");
		expect(WORKFLOW_NOTICE).toContain("Author the orchestration in the `eval` tool");
		expect(WORKFLOW_NOTICE).toContain("JavaScript (`eval`, JavaScript backend):");
		expect(WORKFLOW_NOTICE).toContain("Use ordinary code between calls to flatten/map/filter");
		expect(WORKFLOW_NOTICE).toContain("State persists across eval calls");
		expect(WORKFLOW_NOTICE).toContain("`parallel(thunks)`");
		expect(WORKFLOW_NOTICE).toContain("a negative value disables the cap");
		expect(WORKFLOW_NOTICE).toContain("await budget.remaining()");
	});

	it("renders the same eval notice when task.batch is disabled", () => {
		const notice = renderWorkflowNotice({ taskBatch: false });
		expect(notice).toContain("**workflowz** keyword");
		expect(notice).toContain("Author the orchestration in the `eval` tool");
		expect(notice).toContain("JavaScript (`eval`, JavaScript backend):");
		expect(notice).toContain("State persists across eval calls");
		expect(notice).toContain("`parallel(thunks)`");
	});
});
