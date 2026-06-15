import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createAdvisorMessageCard } from "../../modes/components/advisor-message";
import { getThemeByName } from "../../modes/theme/theme";
import { formatSessionHistoryMarkdown } from "../../session/session-history-format";
import { YieldQueue } from "../../session/yield-queue";
import {
	ADVISOR_READONLY_TOOL_NAMES,
	AdviseTool,
	type AdvisorAgent,
	AdvisorRuntime,
	type AdvisorRuntimeHost,
	formatAdvisorBatchContent,
	isInterruptingSeverity,
} from "..";

describe("advisor", () => {
	describe("formatSessionHistoryMarkdown includeThinking", () => {
		it("includes thinking text when includeThinking is true", () => {
			const thinking = "I should check the edge case first.";
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "thinking", thinking }],
				timestamp: Date.now(),
			} as AgentMessage;
			const md = formatSessionHistoryMarkdown([assistantMsg], { includeThinking: true });
			expect(md).toContain(thinking);
			expect(md).toContain("_thinking:_");
		});

		it("elides thinking text by default", () => {
			const thinking = "I should check the edge case first.";
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "thinking", thinking }],
				timestamp: Date.now(),
			} as AgentMessage;
			const md = formatSessionHistoryMarkdown([assistantMsg]);
			expect(md).not.toContain(thinking);
			expect(md).not.toContain("_thinking:_");
		});
	});

	describe("advisor yield-queue dispatcher", () => {
		it("batches advice notes into one custom message", async () => {
			const injected: AgentMessage[] = [];
			const yq = new YieldQueue({
				isStreaming: () => false,
				injectIdle: async messages => {
					injected.push(...messages);
				},
				scheduleIdleFlush: () => {},
			});
			yq.register<{ note: string; severity?: "nit" | "concern" | "blocker" }>("advisor", {
				build: entries =>
					entries.length === 0
						? null
						: ({
								role: "custom",
								customType: "advisor",
								display: true,
								attribution: "agent",
								timestamp: Date.now(),
								content:
									"Advisor (a senior reviewer watching your work — weigh it, don't blindly obey):\n" +
									entries.map(e => `- ${e.severity ? `[${e.severity}] ` : ""}${e.note}`).join("\n"),
							} as AgentMessage),
			});

			yq.enqueue("advisor", { note: "first note" });
			yq.enqueue("advisor", { note: "second note", severity: "blocker" });
			await yq.flush("idle");

			expect(injected).toHaveLength(1);
			const msg = injected[0] as { role: string; customType?: string; display?: boolean; content: string };
			expect(msg.role).toBe("custom");
			expect(msg.customType).toBe("advisor");
			expect(msg.display).toBe(true);
			expect(msg.content).toContain("[blocker] second note");
			expect(msg.content).toContain("- first note");
		});

		it("skipIdleFlush prevents idle scheduling", () => {
			let scheduled = 0;
			const yq = new YieldQueue({
				isStreaming: () => false,
				injectIdle: async () => {},
				scheduleIdleFlush: () => {
					scheduled++;
				},
			});
			yq.register<{ note: string }>("advisor", {
				build: entries => (entries.length === 0 ? null : ({ role: "custom", content: "x" } as AgentMessage)),
				skipIdleFlush: true,
			});
			yq.register<{ note: string }>("normal", {
				build: entries => (entries.length === 0 ? null : ({ role: "custom", content: "y" } as AgentMessage)),
			});

			yq.enqueue("advisor", { note: "a" });
			expect(scheduled).toBe(0);
			yq.enqueue("normal", { note: "b" });
			expect(scheduled).toBe(1);
		});
	});

	describe("AdviseTool", () => {
		it("forwards advice to the callback and returns details", async () => {
			const onAdvice = vi.fn();
			const tool = new AdviseTool(onAdvice);
			const result = await tool.execute("tc-1", { note: "x", severity: "concern" });
			expect(onAdvice).toHaveBeenCalledWith("x", "concern");
			expect(result.details).toEqual({ note: "x", severity: "concern" });
			expect(result.useless).toBe(true);
		});
	});

	describe("advice delivery policy", () => {
		it("interrupts on concern and blocker, queues a plain nit", () => {
			expect(isInterruptingSeverity("blocker")).toBe(true);
			expect(isInterruptingSeverity("concern")).toBe(true);
			expect(isInterruptingSeverity("nit")).toBe(false);
			expect(isInterruptingSeverity(undefined)).toBe(false);
		});

		it("formats a batch with the advisor prefix and severity-tagged bullets", () => {
			const content = formatAdvisorBatchContent([
				{ note: "first note" },
				{ note: "second note", severity: "blocker" },
			]);
			const lines = content.split("\n");
			expect(lines[0]).toContain("senior reviewer");
			expect(lines[1]).toBe("- first note");
			expect(lines[2]).toBe("- [blocker] second note");
		});
	});

	describe("AdvisorRuntime", () => {
		function makeAgent(promptInputs: string[]): AdvisorAgent {
			return {
				prompt: async input => {
					promptInputs.push(input);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
		}

		it("coalesces multiple onTurnEnd calls while a prompt is in-flight", async () => {
			const promptInputs: string[] = [];
			const { promise: firstPromptPromise, resolve: finishFirstPrompt } = Promise.withResolvers<void>();
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					await firstPromptPromise;
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [{ role: "user", content: "first", timestamp: 1 } as AgentMessage];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host);

			runtime.onTurnEnd();
			await Promise.resolve();
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("first");

			messages.push({ role: "user", content: "second", timestamp: 2 } as AgentMessage);
			runtime.onTurnEnd();
			await Promise.resolve();
			expect(promptInputs).toHaveLength(1);

			finishFirstPrompt();
			await Promise.resolve();
			await Promise.resolve();
			expect(promptInputs).toHaveLength(2);
			expect(promptInputs[1]).toContain("second");
		});

		it("excludes advisor custom messages from the rendered delta", () => {
			const promptInputs: string[] = [];
			const agent = makeAgent(promptInputs);
			const messages: AgentMessage[] = [
				{ role: "user", content: "hello", timestamp: 1 } as AgentMessage,
				{ role: "custom", customType: "advisor", content: "note", display: true, timestamp: 2 } as AgentMessage,
			];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host);
			runtime.onTurnEnd();
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("hello");
			expect(promptInputs[0]).not.toContain("note");
		});

		it("handles compaction shrink without prompting", () => {
			const promptInputs: string[] = [];
			const agent = makeAgent(promptInputs);
			let messages: AgentMessage[] = [
				{ role: "user", content: "a", timestamp: 1 } as AgentMessage,
				{ role: "user", content: "b", timestamp: 2 } as AgentMessage,
			];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host);
			runtime.onTurnEnd();
			expect(promptInputs).toHaveLength(1);

			messages = [{ role: "user", content: "a", timestamp: 1 } as AgentMessage];
			expect(() => runtime.onTurnEnd()).not.toThrow();
			expect(promptInputs).toHaveLength(1);
		});

		it("reset re-primes the advisor with the full current transcript", async () => {
			const promptInputs: string[] = [];
			const agent = makeAgent(promptInputs);
			const messages: AgentMessage[] = [{ role: "user", content: "aaa", timestamp: 1 } as AgentMessage];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host);
			runtime.onTurnEnd();
			await Promise.resolve();
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("aaa");

			// Simulate a compaction: transcript replaced, then reset.
			messages.length = 0;
			messages.push({ role: "user", content: "summary-bbb", timestamp: 2 } as AgentMessage);
			runtime.reset();

			runtime.onTurnEnd();
			await Promise.resolve();
			// The next turn replays the full post-compaction transcript, not just new tail.
			expect(promptInputs).toHaveLength(2);
			expect(promptInputs[1]).toContain("summary-bbb");
		});

		it("triggers a re-prime and full replay when maintainContext returns true", async () => {
			const promptInputs: string[] = [];
			const agent = makeAgent(promptInputs);
			const messages: AgentMessage[] = [{ role: "user", content: "aaa", timestamp: 1 } as AgentMessage];
			let shouldRePrime = false;
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
				maintainContext: async tokens => {
					expect(tokens).toBeGreaterThan(0);
					return shouldRePrime;
				},
			};
			const runtime = new AdvisorRuntime(agent, host);

			// First turn: normal incremental prompt
			runtime.onTurnEnd();
			await Promise.resolve();
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("aaa");

			// Second turn: maintainContext resolves true, triggering a re-prime
			shouldRePrime = true;
			messages.push({ role: "user", content: "bbb", timestamp: 2 } as AgentMessage);
			runtime.onTurnEnd();
			await Promise.resolve();
			await Promise.resolve();

			// The reset cleared history and prompted a full replay (so the batch contains both aaa and bbb)
			expect(promptInputs).toHaveLength(2);
			expect(promptInputs[1]).toContain("aaa");
			expect(promptInputs[1]).toContain("bbb");
		});
	});

	describe("read-only tool allowlist", () => {
		it("selects only the investigation tools from a mixed toolset", () => {
			const toolset = ["read", "edit", "search", "bash", "find", "write", "advise"];
			const selected = toolset.filter(name => ADVISOR_READONLY_TOOL_NAMES.has(name));
			expect(selected).toEqual(["read", "search", "find"]);
			expect(ADVISOR_READONLY_TOOL_NAMES.has("edit")).toBe(false);
			expect(ADVISOR_READONLY_TOOL_NAMES.has("bash")).toBe(false);
			expect(ADVISOR_READONLY_TOOL_NAMES.has("write")).toBe(false);
		});
	});

	describe("createAdvisorMessageCard", () => {
		const strip = (lines: readonly string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

		it("renders the advisor header, severity badge, and note text", async () => {
			const uiTheme = await getThemeByName("dark");
			if (!uiTheme) throw new Error("theme unavailable");
			const card = createAdvisorMessageCard(
				{ notes: [{ note: "deleting the wrong file", severity: "blocker" }, { note: "watch the empty case" }] },
				() => true,
				uiTheme,
			);
			const text = strip(card.render(80));
			expect(text).toContain("Advisor");
			expect(text).toContain("2 notes");
			expect(text).toContain("blocker");
			expect(text).toContain("deleting the wrong file");
			expect(text).toContain("watch the empty case");
		});

		it("collapses to the first notes with an overflow hint", async () => {
			const uiTheme = await getThemeByName("dark");
			if (!uiTheme) throw new Error("theme unavailable");
			const notes = Array.from({ length: 5 }, (_, i) => ({ note: `note ${i}` }));
			const card = createAdvisorMessageCard({ notes }, () => false, uiTheme);
			const text = strip(card.render(80));
			expect(text).toContain("note 0");
			expect(text).toContain("+2 more");
			expect(text).not.toContain("note 4");
		});

		it("wraps long notes across multiple lines based on render width instead of truncating them", async () => {
			const uiTheme = await getThemeByName("dark");
			if (!uiTheme) throw new Error("theme unavailable");
			const note =
				"This is a very long advisor note that will definitely exceed the restricted width constraint of thirty characters and should therefore wrap across multiple lines rather than getting truncated.";
			const card = createAdvisorMessageCard({ notes: [{ note, severity: "concern" }] }, () => true, uiTheme);
			const text = strip(card.render(30));
			expect(text).toContain("truncated.");
		});
	});
});
