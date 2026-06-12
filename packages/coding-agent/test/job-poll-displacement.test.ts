/**
 * Repeated `job` polls must not stack "waiting on N jobs" frames in the
 * transcript: a poll whose watched jobs are all still running stays live
 * (displaceable) and the next `job` call replaces it — one persistent poll.
 *
 * Contracts under test:
 *  - ToolExecutionComponent: a waiting-poll result keeps the block
 *    un-finalized and displaceable; a settled/cancelled/error result
 *    finalizes normally; seal() always freezes.
 *  - EventController: a follow-up `job` call removes the tracked waiting
 *    poll from the transcript; any other tool seals it in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { Component, TUI } from "@oh-my-pi/pi-tui";

const uiStub = { requestRender() {} } as unknown as TUI;

type JobStatus = "running" | "completed" | "failed" | "cancelled";

function pollResult(statuses: JobStatus[], extra: { cancelled?: boolean; isError?: boolean } = {}) {
	return {
		content: [{ type: "text" as const, text: "" }],
		isError: extra.isError,
		details: {
			jobs: statuses.map((status, i) => ({
				id: `j${i}`,
				type: "task" as const,
				status,
				label: `job ${i}`,
				durationMs: 1_000,
			})),
			...(extra.cancelled ? { cancelled: [{ id: "j0", status: "cancelled" as const }] } : {}),
		},
	};
}

function trackComponent(components: ToolExecutionComponent[], component: ToolExecutionComponent) {
	components.push(component);
	return component;
}

describe("job waiting-poll block lifecycle", () => {
	const created: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		// Seal everything so displaceable blocks' spinner intervals never leak
		// into later test files.
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function makeJobComponent() {
		return trackComponent(created, new ToolExecutionComponent("job", { poll: ["j0", "j1"] }, {}, undefined, uiStub));
	}

	it("keeps an all-running poll live and displaceable until sealed", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["running", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(true);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.seal();
		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a poll that observed a settled job", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["completed", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a poll that carried cancel outcomes or an error", () => {
		const cancelled = makeJobComponent();
		cancelled.updateResult(pollResult(["running"], { cancelled: true }), false);
		expect(cancelled.isDisplaceableBlock()).toBe(false);

		const errored = makeJobComponent();
		errored.updateResult(pollResult(["running"], { isError: true }), false);
		expect(errored.isDisplaceableBlock()).toBe(false);
		expect(errored.isTranscriptBlockFinalized()).toBe(true);
	});

	it("never marks non-job tools displaceable", () => {
		const component = trackComponent(
			created,
			new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub),
		);
		component.updateResult(pollResult(["running"]), false);
		expect(component.isDisplaceableBlock()).toBe(false);
	});
});

describe("EventController displaces consecutive waiting polls", () => {
	const created: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture() {
		const children: Component[] = [];
		const ctx = {
			isInitialized: true,
			init: vi.fn(async () => {}),
			ui: { requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			toolOutputExpanded: false,
			pendingTools: new Map(),
			chatContainer: {
				children,
				addChild: (component: Component) => {
					children.push(component);
				},
				removeChild: (component: Component) => {
					const index = children.indexOf(component);
					if (index !== -1) children.splice(index, 1);
				},
			},
			session: { getToolByName: () => undefined },
			viewSession: { getToolByName: () => undefined },
			sessionManager: { getCwd: () => process.cwd() },
		} as unknown as InteractiveModeContext;
		return { controller: new EventController(ctx), children };
	}

	async function runPoll(controller: EventController, children: Component[], toolCallId: string) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "job",
			args: { poll: ["j0"] },
		});
		const component = children[children.length - 1] as ToolExecutionComponent;
		trackComponent(created, component);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "job",
			result: pollResult(["running", "running"]),
			isError: false,
		});
		return component;
	}

	it("removes the previous waiting poll when the next job call starts", async () => {
		const { controller, children } = createFixture();

		const first = await runPoll(controller, children, "t1");
		expect(children).toContain(first);

		const second = await runPoll(controller, children, "t2");

		// The stale "waiting" frame is gone; only the fresh poll remains.
		expect(children).not.toContain(first);
		expect(children).toContain(second);
		// The displaced block is sealed so its spinner interval is stopped.
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("seals the waiting poll in place when a different tool runs next", async () => {
		const { controller, children } = createFixture();

		const poll = await runPoll(controller, children, "t1");
		expect(poll.isTranscriptBlockFinalized()).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "bash",
			args: { command: "ls" },
		});
		trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		// The poll frame stays — it is final history now, not displaceable.
		expect(children).toContain(poll);
		expect(poll.isTranscriptBlockFinalized()).toBe(true);
		expect(poll.isDisplaceableBlock()).toBe(false);
	});

	it("does not displace a poll that observed completions", async () => {
		const { controller, children } = createFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "job",
			args: { poll: ["j0"] },
		});
		const settled = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "job",
			result: pollResult(["completed", "running"]),
			isError: false,
		});

		const next = await runPoll(controller, children, "t2");

		// A poll that carried real results is kept as history.
		expect(children).toContain(settled);
		expect(children).toContain(next);
	});
});
