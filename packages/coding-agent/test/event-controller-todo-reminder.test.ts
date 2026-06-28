import { beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Container } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false);
});

function createContext() {
	const todoReminderContainer = new Container();
	const present = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		todoReminderContainer,
		setTodos: vi.fn(),
		present,
	} as unknown as InteractiveModeContext;
	return { ctx, todoReminderContainer, present };
}

function reminder(attempt: number, content = "pending task"): Extract<AgentSessionEvent, { type: "todo_reminder" }> {
	return {
		type: "todo_reminder",
		todos: [{ content, status: "pending" }],
		attempt,
		maxAttempts: 3,
	};
}

describe("EventController todo reminder HUD", () => {
	it("renders reminders in the anchored container instead of durable chat history", async () => {
		const { ctx, todoReminderContainer, present } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(reminder(1, "old task"));
		expect(todoReminderContainer.children).toHaveLength(1);
		expect(present).not.toHaveBeenCalled();

		await controller.handleEvent(reminder(2, "new task"));
		expect(todoReminderContainer.children).toHaveLength(1);
		expect(present).not.toHaveBeenCalled();
		expect(ctx.ui.requestRender).toHaveBeenCalled();
	});

	it("keeps reminders visible when an auto-continued turn starts", async () => {
		const { ctx, todoReminderContainer } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(reminder(1));
		const visibleReminder = todoReminderContainer.children[0];

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		expect(todoReminderContainer.children).toHaveLength(1);
		expect(todoReminderContainer.children[0]).toBe(visibleReminder);
		expect(ctx.ensureLoadingAnimation).toHaveBeenCalled();
	});

	it("clears reminders when a todo tool succeeds", async () => {
		const { ctx, todoReminderContainer } = createContext();
		const controller = new EventController(ctx);
		const phases = [{ name: "Implementation", tasks: [{ content: "done task", status: "completed" as const }] }];

		await controller.handleEvent(reminder(1));
		expect(todoReminderContainer.children).toHaveLength(1);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-1",
			toolName: "todo",
			isError: false,
			result: { content: [{ type: "text", text: "" }], details: { phases } },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(todoReminderContainer.children).toHaveLength(0);
		expect(ctx.setTodos).toHaveBeenCalledWith(phases);
	});
});
