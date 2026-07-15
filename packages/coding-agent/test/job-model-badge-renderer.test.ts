import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";
import { Settings, settings } from "../src/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../src/modes/theme/theme";
import type { ToolSession } from "../src/tools";
import { jobsRenderResult, snapshotJobs } from "../src/tools/hub/jobs";
import type { CoordinationDetails } from "../src/tools/hub/types";

const ansiPattern = /\x1b\[[0-9;]*m/g;
const hyperlinkPattern = /\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g;

let uiTheme: Theme;
let priorShowResolvedModelBadge = false;

function renderJobText(details: Omit<CoordinationDetails, "op">, expanded = false): string {
	const component = jobsRenderResult(
		{ content: [{ type: "text", text: "Listed background jobs" }], details: { op: "jobs", ...details } },
		{ expanded, isPartial: false },
		uiTheme,
		{ op: "jobs" },
	);
	let text = component.render(160).join("\n");
	text = text.replace(hyperlinkPattern, "");
	text = text.replace(ansiPattern, "");
	return text;
}

describe("hub jobs task model badges", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	beforeEach(() => {
		priorShowResolvedModelBadge = settings.get("task.showResolvedModelBadge");
	});

	afterEach(() => {
		settings.override("task.showResolvedModelBadge", priorShowResolvedModelBadge);
		settings.clearOverride("task.showResolvedModelBadge");
		vi.restoreAllMocks();
	});

	it("renders a task job's resolved model selector with its explicit reasoning suffix exactly once when enabled", () => {
		settings.override("task.showResolvedModelBadge", true);
		const selector = "anthropic/claude-sonnet-4-20250514:high";
		const text = renderJobText({
			jobs: [
				{
					id: "Architect",
					type: "task",
					status: "completed",
					label: "Architect",
					durationMs: 1_234,
					resultText: "done",
					resolvedModel: selector,
				},
			],
		});

		expect(text).toContain(selector);
		expect(text.split(selector).length - 1).toBe(1);
	});

	it("renders the latest runtime selector from a running task job snapshot", async () => {
		settings.override("task.showResolvedModelBadge", true);
		const selector = "openai-codex/gpt-5.6-luna:max";
		const reported = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<string>();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const id = manager.register(
			"task",
			"Architect",
			async ({ reportProgress }) => {
				await reportProgress("running", {
					progress: [{ id: "Architect", resolvedModel: selector }],
				});
				reported.resolve();
				return finish.promise;
			},
			{ id: "Architect" },
		);
		await reported.promise;

		const session = { asyncJobManager: manager } as unknown as ToolSession;
		const text = renderJobText({ jobs: snapshotJobs(session, manager.getAllJobs()) });

		expect(text).toContain(selector);
		expect(text.split(selector).length - 1).toBe(1);

		finish.resolve("done");
		await manager.getJob(id)?.promise;
	});

	it("hides a task job's resolved model selector when the badge setting is disabled", () => {
		settings.override("task.showResolvedModelBadge", false);
		const selector = "anthropic/claude-sonnet-4-20250514:high";
		const text = renderJobText({
			jobs: [
				{
					id: "Architect",
					type: "task",
					status: "completed",
					label: "Architect",
					durationMs: 1_234,
					resultText: "done",
					resolvedModel: selector,
				},
			],
		});

		expect(text).toContain("Architect");
		expect(text).not.toContain(selector);
	});

	it("does not render resolved model metadata on bash job rows", () => {
		settings.override("task.showResolvedModelBadge", true);
		const selector = "anthropic/claude-sonnet-4-20250514:high";
		const text = renderJobText({
			jobs: [
				{
					id: "shell-1",
					type: "bash",
					status: "completed",
					label: "bun test packages/coding-agent/src/tools/__tests__/job-render.test.ts",
					durationMs: 1_234,
					resultText: "ok",
					resolvedModel: selector,
				},
			],
		});

		expect(text).toContain("shell-1");
		expect(text).toContain("bash");
		expect(text).not.toContain(selector);
	});

	it("renders task rows with missing or malformed resolved model metadata without leaking bogus badges", () => {
		settings.override("task.showResolvedModelBadge", true);
		const text = renderJobText(
			{
				jobs: [
					{
						id: "NoModel",
						type: "task",
						status: "completed",
						label: "missing model metadata",
						durationMs: 0,
						resultText: "done",
					},
					{
						id: "NumericModel",
						type: "task",
						status: "completed",
						label: "numeric model metadata",
						durationMs: 0,
						resultText: "done",
						resolvedModel: 9_001,
					},
					{
						id: "ObjectModel",
						type: "task",
						status: "completed",
						label: "object model metadata",
						durationMs: 0,
						resultText: "done",
						resolvedModel: { selector: "not-a-renderable-selector" },
					},
				],
			} as unknown as Omit<CoordinationDetails, "op">,
			true,
		);

		expect(text).toContain("missing model metadata");
		expect(text).toContain("numeric model metadata");
		expect(text).toContain("object model metadata");
		expect(text).not.toContain("9001");
		expect(text).not.toContain("[object Object]");
		expect(text).not.toContain("not-a-renderable-selector");
	});
});
