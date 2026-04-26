import { describe, expect, it } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { getThemeByName } from "../../src/modes/theme/theme";
import type { GhToolDetails } from "../../src/tools/gh";
import { githubToolRenderer } from "../../src/tools/gh-renderer";
import { toolRenderers } from "../../src/tools/renderers";

describe("githubToolRenderer", () => {
	it("renders a compact ghw-style run summary", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result: {
			content: Array<{ type: string; text?: string }>;
			details?: GhToolDetails;
			isError?: boolean;
		} = {
			content: [{ type: "text", text: "llm-visible text stays unchanged" }],
			details: {
				watch: {
					mode: "run",
					state: "watching",
					repo: "v12-security/v12x",
					run: {
						id: 23856332053,
						workflowName: "CI",
						branch: "dev",
						jobs: [
							{
								id: 1,
								name: "Workflow Lint",
								status: "completed",
								conclusion: "success",
								durationSeconds: 55,
							},
							{
								id: 2,
								name: "Frontend Checks",
								status: "in_progress",
								durationSeconds: 40,
							},
							{
								id: 3,
								name: "Rust Tests",
								status: "queued",
								durationSeconds: 5,
							},
						],
					},
				},
			},
		};

		const component = githubToolRenderer.renderResult(result, { expanded: false, isPartial: true }, uiTheme);
		const rendered = sanitizeText(component.render(64).join("\n"));

		expect(toolRenderers.github).toBeDefined();
		expect(rendered).toContain("watching run #23856332053 on v12-security/v12x");
		expect(rendered).toContain("CI  dev  #23856332053");
		expect(rendered).toContain(`${uiTheme.status.success} Workflow Lint`);
		expect(rendered).toContain(`${uiTheme.status.enabled} Frontend Checks`);
		expect(rendered).toContain(`${uiTheme.status.shadowed} Rust Tests`);
		expect(rendered).toContain("55s");
		expect(rendered).toContain("40s");
		expect(rendered).toContain("5s");
		expect(rendered).not.toContain("llm-visible text stays unchanged");
	});

	it("shows failed log tails without dumping the full log when collapsed", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result: {
			content: Array<{ type: string; text?: string }>;
			details?: GhToolDetails;
			isError?: boolean;
		} = {
			content: [{ type: "text", text: "full markdown result" }],
			details: {
				watch: {
					mode: "run",
					state: "completed",
					repo: "owner/repo",
					run: {
						id: 77,
						workflowName: "CI",
						branch: "feature/bugfix",
						conclusion: "failure",
						jobs: [
							{
								id: 202,
								name: "test",
								status: "completed",
								conclusion: "failure",
								durationSeconds: 360,
							},
						],
					},
					failedLogs: [
						{
							runId: 77,
							workflowName: "CI",
							jobName: "test",
							available: true,
							tail: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].join("\n"),
						},
					],
				},
			},
		};

		const component = githubToolRenderer.renderResult(result, { expanded: false, isPartial: false }, uiTheme);
		const rendered = sanitizeText(component.render(72).join("\n"));

		expect(rendered).toContain("failed logs");
		expect(rendered).toContain("delta");
		expect(rendered).toContain("epsilon");
		expect(rendered).toContain("zeta");
		expect(rendered).not.toContain("alpha");
		expect(rendered).toContain("more log lines");
	});
});
