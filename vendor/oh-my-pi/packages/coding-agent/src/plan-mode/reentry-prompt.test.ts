import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import planModeActivePrompt from "../prompts/system/plan-mode-active.md" with { type: "text" };

const BASE = {
	planFilePath: "local://old-feature-plan.md",
	askToolName: "ask",
	writeToolName: "write",
	editToolName: "edit",
	isHashlineEditMode: false,
	iterative: false,
} as const;

function render(overrides: { reentry: boolean; planExists: boolean }): string {
	return prompt.render(planModeActivePrompt, { ...BASE, ...overrides });
}

describe("plan-mode re-entry prompt", () => {
	it("only emits the Re-entry section when re-entering", () => {
		expect(render({ reentry: false, planExists: true })).not.toContain("## Re-entry");
		expect(render({ reentry: true, planExists: true })).toContain("## Re-entry");
	});

	it("anchors the turn on the new request, not the old plan", () => {
		const rendered = render({ reentry: true, planExists: true });
		const reentry = rendered.slice(rendered.indexOf("## Re-entry"));
		// The new request is the primary input; the old plan is reference only.
		expect(reentry).toMatch(/NEW request[\s\S]*primary input/);
		// Corrections to an incomplete old plan must be folded into the new plan,
		// never substituted for it (the reported failure: dropping the new request).
		expect(reentry).toMatch(/combine, never substitute/);
	});

	it("does not contradict the planExists guidance on a different task", () => {
		const rendered = render({ reentry: true, planExists: true });
		// planExists branch: different task -> leave old plan, write a fresh file.
		expect(rendered).toContain("leave that plan in place and start a fresh");
		// Re-entry must agree; the old "Different task -> overwrite it" directive is gone.
		expect(rendered).not.toMatch(/[Dd]ifferent task → overwrite/);
	});
});
