import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const W = 100;

function msg(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...extra,
	};
}

/** Render `m` on a brand-new component, which always takes the teardown path. */
function teardownRender(m: AssistantMessage): string {
	const fresh = new AssistantMessageComponent();
	fresh.updateContent(m);
	return fresh.render(W).join("\n");
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

// Contract: the streaming fast path (a component reused across updateContent
// calls, which reuses Markdown children via setText) MUST render byte-identical
// output to the teardown path (a fresh component that rebuilds every child) for
// the same message — at every step. If they ever diverge, the optimization
// silently corrupts the transcript.
describe("AssistantMessageComponent streaming fast path", () => {
	it("matches teardown output across a growing thinking + text stream", () => {
		const reused = new AssistantMessageComponent();
		const thinking = "Reasoning about the **problem** with `code` and a list:\n- a\n- b";
		const steps = [
			"He",
			"Hello, ",
			"Hello, world.",
			"Hello, world.\n\n## Heading\n\nSome `inline` and **bold** text.",
			"Hello, world.\n\n## Heading\n\nSome `inline` and **bold** text.\n\n```ts\nconst x = 1;\n```",
		];
		for (const text of steps) {
			const m = msg([
				{ type: "thinking", thinking },
				{ type: "text", text },
			]);
			reused.updateContent(m);
			expect(reused.render(W).join("\n")).toBe(teardownRender(m));
		}
	});

	it("matches teardown for a single growing text block", () => {
		const reused = new AssistantMessageComponent();
		let text = "";
		for (const chunk of ["The ", "quick ", "brown ", "**fox** ", "jumps."]) {
			text += chunk;
			const m = msg([{ type: "text", text }]);
			reused.updateContent(m);
			expect(reused.render(W).join("\n")).toBe(teardownRender(m));
		}
	});

	// Regression: #fastPathItems are keyed by raw content index, but a
	// `redactedThinking` block is not rendered. If one appears mid-stream it
	// shifts the indices of the visible blocks; the shape key must reflect that
	// (or the fast path must fail closed) so children are not mis-targeted.
	it("matches teardown when a redactedThinking block shifts indices mid-stream", () => {
		const reused = new AssistantMessageComponent();
		const a = msg([
			{ type: "thinking", thinking: "step one details here" },
			{ type: "text", text: "answer one" },
		]);
		reused.updateContent(a);
		expect(reused.render(W).join("\n")).toBe(teardownRender(a));

		// A redactedThinking block appears at index 0, pushing thinking->1, text->2.
		const b = msg([
			{ type: "redactedThinking", data: "opaque-blob" },
			{ type: "thinking", thinking: "step two with more detail" },
			{ type: "text", text: "answer two is longer now" },
		]);
		reused.updateContent(b);
		expect(reused.render(W).join("\n")).toBe(teardownRender(b));
	});

	it("matches teardown when an error trailer appears after streamed text", () => {
		const reused = new AssistantMessageComponent();
		const ok = msg([{ type: "text", text: "partial answer in progress" }]);
		reused.updateContent(ok);
		expect(reused.render(W).join("\n")).toBe(teardownRender(ok));

		const errored = msg([{ type: "text", text: "partial answer in progress" }], {
			stopReason: "error",
			errorMessage: "upstream 502",
		});
		reused.updateContent(errored);
		expect(reused.render(W).join("\n")).toBe(teardownRender(errored));
	});

	it("matches teardown when a block visibility toggles (empty -> non-empty)", () => {
		const reused = new AssistantMessageComponent();
		// First an empty trailing text block (not rendered), then it gains content.
		const empty = msg([
			{ type: "thinking", thinking: "thinking out loud" },
			{ type: "text", text: "" },
		]);
		reused.updateContent(empty);
		expect(reused.render(W).join("\n")).toBe(teardownRender(empty));

		const filled = msg([
			{ type: "thinking", thinking: "thinking out loud" },
			{ type: "text", text: "now there is an answer" },
		]);
		reused.updateContent(filled);
		expect(reused.render(W).join("\n")).toBe(teardownRender(filled));
	});
});
