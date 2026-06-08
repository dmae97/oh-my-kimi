/**
 * Regression guard for the incremental per-message token cache in
 * `StatusLineComponent.getCachedContextBreakdown`.
 *
 * Before the cache: every call walked `session.messages` and ran
 * `estimateTokens` per message (~0.5 ms each native). For a 2,300-message
 * session this was a ~1.1 s blocking call. `updateEditorTopBorder()` is
 * invoked on every agent event (event-controller.ts:163), so during
 * streaming the UI froze for ~1.1 s every 2 s (the prior cache TTL).
 *
 * After the cache: messages are walked ONCE during warm-up; subsequent
 * refreshes append-only update the cache by `messages.length - cached`
 * (typically 0–1 new messages). The LAST message is recomputed every call
 * because its content may still be growing during streaming. Compaction
 * (messages.length shrinks) resets the cache.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { computeNonMessageTokens, estimateToolSchemaTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { countTokens } from "@oh-my-pi/pi-natives";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function makeSession(opts: {
	messages: unknown[];
	systemPrompt?: string[];
	tools?: { name: string; description: string; parameters?: unknown }[];
	skills?: { name: string; description: string }[];
	contextWindow?: number;
	modelId?: string;
}): AgentSession {
	const messages = opts.messages;
	return {
		messages,
		systemPrompt: opts.systemPrompt ?? ["You are a helpful assistant."],
		agent: { state: { tools: opts.tools ?? [] } },
		skills: opts.skills ?? [],
		model: { id: opts.modelId ?? "test-model", contextWindow: opts.contextWindow ?? 200_000 },
		state: { messages, model: { contextWindow: opts.contextWindow ?? 200_000 } },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as AgentSession;
}

function userMessage(text: string): unknown {
	return { role: "user", content: text };
}
function assistantMessage(text: string): unknown {
	return { role: "assistant", content: [{ type: "text", text }] };
}

describe("StatusLineComponent incremental context breakdown cache", () => {
	it("first call computes from scratch, second call returns same value", () => {
		const session = makeSession({
			messages: Array.from({ length: 50 }, (_, i) => userMessage(`message ${i}`.repeat(10))),
		});
		const comp = new StatusLineComponent(session);

		const first = comp.getCachedContextBreakdown();
		const second = comp.getCachedContextBreakdown();

		expect(first.usedTokens).toBeGreaterThan(0);
		expect(second.usedTokens).toBe(first.usedTokens);
		expect(second.contextWindow).toBe(200_000);
	});

	it("appending a message increases the total by approximately the new message's tokens", () => {
		const session = makeSession({
			messages: [userMessage("hello world"), userMessage("another message here")],
		});
		const comp = new StatusLineComponent(session);

		const before = comp.getCachedContextBreakdown();
		(session.messages as unknown[]).push(assistantMessage("a third message reply with more text content"));
		const after = comp.getCachedContextBreakdown();

		expect(after.usedTokens).toBeGreaterThan(before.usedTokens);
		expect(after.contextWindow).toBe(before.contextWindow);
	});

	it("popping the streaming tail rebuilds instead of double-counting the new tail", () => {
		const messages = [
			userMessage("stable head"),
			userMessage("tail that becomes stable after append".repeat(20)),
			assistantMessage("streaming tail removed by retry".repeat(20)),
		];
		const session = makeSession({ messages });
		const comp = new StatusLineComponent(session);

		const withStreamingTail = comp.getCachedContextBreakdown();
		messages.pop();
		const afterPop = comp.getCachedContextBreakdown();
		const freshAfterPop = new StatusLineComponent(session).getCachedContextBreakdown();

		expect(afterPop.usedTokens).toBeLessThan(withStreamingTail.usedTokens);
		expect(afterPop.usedTokens).toBe(freshAfterPop.usedTokens);
	});

	it("compaction (messages.length shrinks) resets the cache and recomputes correctly", () => {
		const session = makeSession({
			messages: Array.from({ length: 20 }, (_, i) => userMessage(`message ${i}`.repeat(10))),
		});
		const comp = new StatusLineComponent(session);

		const before = comp.getCachedContextBreakdown();
		expect(before.usedTokens).toBeGreaterThan(0);

		(session.messages as unknown[]).length = 0;
		(session.messages as unknown[]).push(userMessage("compacted summary"));

		const after = comp.getCachedContextBreakdown();
		expect(after.usedTokens).toBeLessThan(before.usedTokens);
		expect(after.usedTokens).toBeGreaterThan(0);
	});

	it("non-message inputs change → recomputes non-message portion", () => {
		const session = makeSession({
			messages: [userMessage("hi")],
			systemPrompt: ["You are an assistant."],
			tools: [{ name: "bash", description: "Run shell commands", parameters: {} }],
			skills: [{ name: "code", description: "Write code" }],
		});
		const comp = new StatusLineComponent(session);

		const v1 = comp.getCachedContextBreakdown();
		const v2 = comp.getCachedContextBreakdown();
		expect(v2.usedTokens).toBe(v1.usedTokens);

		(session.agent as { state: { tools: unknown[] } }).state.tools.push({
			name: "edit",
			description: "Edit files",
			parameters: {},
		});
		const v3 = comp.getCachedContextBreakdown();
		expect(v3.usedTokens).toBeGreaterThan(v2.usedTokens);
	});

	it("non-message token shortcut matches previous category sum semantics", () => {
		const session = makeSession({
			messages: [],
			systemPrompt: [
				"You are an assistant.\n\n<skills>\n- code: Write code\n- review: Review code\n</skills>",
				"Loaded context file",
				"Runtime note",
			],
			tools: [
				{
					name: "bash",
					description: "Run shell commands",
					parameters: { type: "object", properties: { command: { type: "string" } } },
				},
			],
			skills: [
				{ name: "code", description: "Write code" },
				{ name: "review", description: "Review code" },
			],
		});

		const skillsTokens = countTokens(["code", "Write code", "review", "Review code"]);
		const previousCategorySum =
			Math.max(0, countTokens(session.systemPrompt?.[0] ?? "") - skillsTokens) +
			countTokens((session.systemPrompt ?? []).slice(1)) +
			estimateToolSchemaTokens(session.agent?.state?.tools ?? []) +
			skillsTokens;

		expect(new StatusLineComponent(session).getCachedContextBreakdown().usedTokens).toBe(previousCategorySum);
		expect(computeNonMessageTokens(session)).toBe(previousCategorySum);
	});

	it("zero messages: produces only non-message tokens, no crash", () => {
		const session = makeSession({ messages: [] });
		const comp = new StatusLineComponent(session);
		const result = comp.getCachedContextBreakdown();
		expect(result.usedTokens).toBeGreaterThanOrEqual(0);
		expect(result.contextWindow).toBe(200_000);
	});

	it("in-place mutation of a recently promoted stable message recomputes its tokens", () => {
		const head = userMessage("head");
		const promoted = userMessage("promoted");
		const tail = userMessage("tail");
		const session = makeSession({ messages: [head, promoted, tail] });
		const comp = new StatusLineComponent(session);

		const before = comp.getCachedContextBreakdown();
		// Mutate the most recently promoted stable message in place — this is the
		// only stable slot we intentionally revalidate on the hot path.
		(promoted as { content: string }).content = "a much longer body that should tokenize to more".repeat(20);
		const after = comp.getCachedContextBreakdown();

		expect(after.usedTokens).toBeGreaterThan(before.usedTokens);
	});

	it("getTopBorder skips context accounting when no context segments are rendered", () => {
		const session = makeSession({
			messages: Array.from({ length: 20 }, (_, i) => userMessage(`message ${i}`.repeat(10))),
		});
		const comp = new StatusLineComponent(session);
		const before = comp.getCachedContextBreakdown();

		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
		});

		const border = comp.getTopBorder(80);
		expect(border.content.length).toBeGreaterThan(0);
		expect(comp.getCachedContextBreakdown()).toEqual(before);
	});

	it("replaceMessages with same length but different shape recomputes tokens", () => {
		const session = makeSession({
			messages: [userMessage("short a"), userMessage("short b")],
		});
		const comp = new StatusLineComponent(session);

		const before = comp.getCachedContextBreakdown();
		// Same-length replace: distinct message objects with larger payloads.
		(session as { messages: unknown[] }).messages = [
			userMessage("a much longer payload".repeat(20)),
			userMessage("another longer payload".repeat(20)),
		];
		const after = comp.getCachedContextBreakdown();

		expect(after.usedTokens).toBeGreaterThan(before.usedTokens);
	});

	it("usage fetch error backs off — a failed fetch does not retrigger within the TTL window", async () => {
		const session = makeSession({ messages: [userMessage("hi")] });
		let calls = 0;
		(session as { fetchUsageReports?: () => Promise<unknown> }).fetchUsageReports = () => {
			calls++;
			return Promise.reject(new Error("network"));
		};
		const comp = new StatusLineComponent(session);

		// First refresh → kicks off fetch #1.
		comp.refreshUsageInBackground();
		// Let the rejected fetch settle so the .catch backoff stamp lands.
		await Bun.sleep(0);
		expect(calls).toBe(1);

		// Subsequent refreshes within the TTL window must not refetch.
		comp.refreshUsageInBackground();
		comp.refreshUsageInBackground();
		await Bun.sleep(0);
		expect(calls).toBe(1);
	});
});
