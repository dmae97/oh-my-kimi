import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TERMINAL } from "@oh-my-pi/pi-tui";

type MutableTerminalInfo = { eagerEraseScrollbackRisk: boolean };
const mutableTerminalInfo = TERMINAL as unknown as MutableTerminalInfo;

function makeThinkingMessage(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const PARA = (n: number) =>
	`I'm realizing paragraph ${n} that thinking inference only happens when model.reasoning is enabled, so for a live-discovered model to get adaptive thinking configured, it needs reasoning true set upfront. That value comes from the defaults in the OpenAI-compatible models fetch, which gets applied when mapping a model without an existing reference.`;

describe("scratch: streaming thinking commit boundary", () => {
	beforeAll(async () => {
		await initTheme();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	it("traces commitSafeEnd while streaming styled thinking", () => {
		const saved = TERMINAL.eagerEraseScrollbackRisk;
		mutableTerminalInfo.eagerEraseScrollbackRisk = true;
		try {
			const chat = new TranscriptContainer();
			const component = new AssistantMessageComponent(undefined, false);
			chat.addChild(component);

			const fullText = [PARA(1), PARA(2), PARA(3)].join("\n\n");
			const words = fullText.split(" ");

			let prevRows: string[] = [];
			let firstStall: number | undefined;
			// stream ~5 words per frame (30fps coalescing)
			for (let i = 5; i <= words.length; i += 5) {
				const text = words.slice(0, i).join(" ");
				component.updateContent(makeThinkingMessage(text));
				const rows = chat.render(120);
				const safeEnd = chat.getNativeScrollbackCommitSafeEnd();
				if (safeEnd === undefined && rows.length > 3 && firstStall === undefined) {
					firstStall = i;
					// dump the frame diff that broke append-only detection
					console.log(`--- stall at word ${i}, rows=${rows.length}, prevRows=${prevRows.length}`);
					const limit = Math.max(prevRows.length, rows.length);
					for (let r = 0; r < limit; r++) {
						if (prevRows[r] !== rows[r]) {
							console.log(`  row ${r} prev: ${JSON.stringify(prevRows[r])}`);
							console.log(`  row ${r} cur : ${JSON.stringify(rows[r])}`);
						}
					}
				}
				prevRows = rows;
			}
			console.log(`total words=${words.length}, firstStall=${firstStall}`);
			expect(firstStall).toBeUndefined();
		} finally {
			mutableTerminalInfo.eagerEraseScrollbackRisk = saved;
		}
	});
});
