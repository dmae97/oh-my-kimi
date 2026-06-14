/**
 * Regression: when `display.showTokenUsage` is on, the per-turn token-usage row
 * must render BELOW the turn's tool blocks on the transcript-rebuild path — including
 * `read` tool groups, which are only materialized when their `toolResult` message is
 * processed (not in the assistant pass). A naive append in the assistant branch put the
 * row above the read group, diverging from the live path. The fix defers the row and
 * flushes it after the turn's tools are placed.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { Container } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";

// 4242 → "4.2K": distinctive enough not to collide with a read group's render.
const USAGE_INPUT = 4242;
const USAGE_LABEL = formatNumber(USAGE_INPUT);

function readTurn(): AgentMessage[] {
	const assistant = {
		role: "assistant",
		content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/foo.ts" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: USAGE_INPUT,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: USAGE_INPUT + 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as unknown as AgentMessage;
	const toolResult = {
		role: "toolResult",
		toolCallId: "r1",
		toolName: "read",
		content: [{ type: "text", text: "line1\nline2" }],
		timestamp: Date.now(),
	} as unknown as AgentMessage;
	return [assistant, toolResult];
}

function makeHarness(showTokenUsage: boolean): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	let helpers: UiHelpers;
	const ctx = {
		chatContainer: new Container(),
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { get: (key: string) => (key === "display.showTokenUsage" ? showTokenUsage : false) },
		addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
		session: {
			retryAttempt: 0,
			getToolByName: () => undefined,
			sessionManager: { getCwd: () => process.cwd() },
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { ctx, helpers };
}

describe("UiHelpers.renderSessionContext token-usage row placement", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("places the usage row below the read group for a read turn", () => {
		const { ctx, helpers } = makeHarness(true);
		helpers.renderSessionContext({ messages: readTurn() } as SessionContext);

		const children = ctx.chatContainer.children;
		const readIdx = children.findIndex(c => c instanceof ReadToolGroupComponent);
		expect(readIdx).toBeGreaterThanOrEqual(0);

		// The usage row is the trailing block and renders the turn's input tokens.
		const last = children[children.length - 1]!;
		expect(last.render(120).join("\n")).toContain(USAGE_LABEL);
		// And it sits strictly below the read group (the bug placed it above).
		expect(children.length - 1).toBeGreaterThan(readIdx);
		// Exactly one usage row — no duplication.
		expect(children.filter(c => c.render(120).join("\n").includes(USAGE_LABEL))).toHaveLength(1);
	});

	it("renders no usage row when showTokenUsage is off", () => {
		const { ctx, helpers } = makeHarness(false);
		helpers.renderSessionContext({ messages: readTurn() } as SessionContext);

		const children = ctx.chatContainer.children;
		expect(children.some(c => c.render(120).join("\n").includes(USAGE_LABEL))).toBe(false);
		// Last block is the read group, not a usage row.
		expect(children[children.length - 1]).toBeInstanceOf(ReadToolGroupComponent);
	});
});
