import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createAdvisorMessageCard } from "../../modes/components/advisor-message";
import { getThemeByName } from "../../modes/theme/theme";
import { formatSessionDumpText } from "../../session/session-dump-format";
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

		it("budgets only the batch sent after async context maintenance", async () => {
			const promptInputs: string[] = [];
			const { promise: firstMaintainStarted, resolve: startFirstMaintain } = Promise.withResolvers<void>();
			const { promise: finishFirstMaintain, resolve: releaseFirstMaintain } = Promise.withResolvers<boolean>();
			const { promise: firstPromptStarted, resolve: startFirstPrompt } = Promise.withResolvers<void>();
			const { promise: secondPromptStarted, resolve: startSecondPrompt } = Promise.withResolvers<void>();
			const { promise: finishFirstPrompt, resolve: releaseFirstPrompt } = Promise.withResolvers<void>();
			let maintainCalls = 0;
			let promptCalls = 0;
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					promptCalls++;
					if (promptCalls === 1) {
						startFirstPrompt();
						await finishFirstPrompt;
					} else if (promptCalls === 2) {
						startSecondPrompt();
					}
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [{ role: "user", content: "first", timestamp: 1 } as AgentMessage];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
				maintainContext: async () => {
					maintainCalls++;
					if (maintainCalls === 1) {
						startFirstMaintain();
						return await finishFirstMaintain;
					}
					return false;
				},
			};
			const runtime = new AdvisorRuntime(agent, host);

			runtime.onTurnEnd();
			await firstMaintainStarted;
			messages.push({ role: "user", content: "second", timestamp: 2 } as AgentMessage);
			runtime.onTurnEnd();

			releaseFirstMaintain(false);
			await firstPromptStarted;
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("first");
			expect(promptInputs[0]).not.toContain("second");

			releaseFirstPrompt();
			await secondPromptStarted;
			expect(promptInputs).toHaveLength(2);
			expect(promptInputs[1]).toContain("second");
		});

		it("sends the batch when context maintenance fails", async () => {
			const promptInputs: string[] = [];
			const agent = makeAgent(promptInputs);
			const messages: AgentMessage[] = [{ role: "user", content: "first", timestamp: 1 } as AgentMessage];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
				maintainContext: async () => {
					throw new Error("maintenance failed");
				},
			};
			const runtime = new AdvisorRuntime(agent, host);

			runtime.onTurnEnd();
			await Promise.resolve();
			await Promise.resolve();

			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("first");
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
			let resetCount = 0;
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
				},
				abort: () => {},
				reset: () => {
					resetCount++;
				},
				state: { messages: [] },
			};
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
			runtime.onTurnEnd(messages);
			await Promise.resolve();
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("aaa");
			expect(resetCount).toBe(0);

			// Second turn: maintainContext resolves true, triggering a re-prime
			shouldRePrime = true;
			messages.push({ role: "user", content: "bbb", timestamp: 2 } as AgentMessage);
			runtime.onTurnEnd(messages);
			await Promise.resolve();
			await Promise.resolve();

			// The reset cleared history and prompted a full replay (so the batch contains both aaa and bbb)
			expect(promptInputs).toHaveLength(2);
			expect(promptInputs[1]).toContain("aaa");
			expect(promptInputs[1]).toContain("bbb");
			expect(resetCount).toBe(1);
		});
		it("tracks backlog and blocks until caught up", async () => {
			const promptInputs: string[] = [];
			const { promise: promptStarted, resolve: startPrompt } = Promise.withResolvers<void>();
			const { promise: promptFinish, resolve: finishPrompt } = Promise.withResolvers<void>();
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					startPrompt();
					await promptFinish;
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [{ role: "user", content: "aaa", timestamp: 1 } as AgentMessage];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host);

			// First turn starts advisor drain (which is now busy).
			runtime.onTurnEnd(messages);
			await promptStarted;

			// Second turn completes. Backlog is now 2 (1 in-flight, 1 pending).
			messages.push({ role: "user", content: "bbb", timestamp: 2 } as AgentMessage);
			runtime.onTurnEnd(messages);

			// waitForCatchup with threshold=2 should resolve immediately (backlog 2 is < threshold 2? No, backlog 2 is not < 2, so it waits. Wait, threshold=3 should resolve immediately since backlog 2 < 3).
			// Let's verify: backlog=2.
			// threshold=3 -> backlog < 3 is true -> resolves immediately.
			let threshold3Resolved = false;
			void runtime.waitForCatchup(100, 3).then(() => {
				threshold3Resolved = true;
			});
			await Promise.resolve();
			expect(threshold3Resolved).toBe(true);

			// threshold=2 -> backlog < 2 is false -> should wait.
			let threshold2Resolved = false;
			const catchupPromise = runtime.waitForCatchup(1000, 2).then(() => {
				threshold2Resolved = true;
			});

			await Promise.resolve();
			expect(threshold2Resolved).toBe(false);

			// Complete the first prompt. Backlog should drop to 1 (prompt finishes, decrements by 1).
			// Wait, the popped entries had turns = 1. So backlog drops to 1.
			// Since 1 < 2, the threshold=2 waiter should resolve.
			finishPrompt();
			await catchupPromise;
			expect(threshold2Resolved).toBe(true);
		});

		it("cancels catch-up waits when the run aborts", async () => {
			const { promise: promptStarted, resolve: startPrompt } = Promise.withResolvers<void>();
			const { promise: promptFinish, resolve: finishPrompt } = Promise.withResolvers<void>();
			const agent: AdvisorAgent = {
				prompt: async () => {
					startPrompt();
					await promptFinish;
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [{ role: "user", content: "aaa", timestamp: 1 } as AgentMessage];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host);
			const controller = new AbortController();

			runtime.onTurnEnd(messages);
			await promptStarted;

			let resolved = false;
			const wait = runtime.waitForCatchup(30000, 1, controller.signal).then(() => {
				resolved = true;
			});

			await Promise.resolve();
			expect(resolved).toBe(false);

			controller.abort();
			await wait;
			expect(resolved).toBe(true);

			finishPrompt();
			await Promise.resolve();
		});

		it("retries failed prompts and only decrements backlog on success", async () => {
			const promptInputs: string[] = [];
			let fail = true;
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					if (fail) {
						fail = false;
						throw new Error("fail");
					}
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [{ role: "user", content: "aaa", timestamp: 1 } as AgentMessage];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host, 0);

			runtime.onTurnEnd(messages);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(promptInputs).toHaveLength(2);
			expect(runtime.backlog).toBe(0);
		});

		it("drops backlog after 3 consecutive failures to prevent permanent stall", async () => {
			const promptInputs: string[] = [];
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					throw new Error("fail");
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [{ role: "user", content: "aaa", timestamp: 1 } as AgentMessage];
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host, 0);

			runtime.onTurnEnd(messages);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(promptInputs).toHaveLength(3);
			expect(runtime.backlog).toBe(0);
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

		it("wraps long notes even when the message card is collapsed", async () => {
			const uiTheme = await getThemeByName("dark");
			if (!uiTheme) throw new Error("theme unavailable");
			const note =
				"This is a very long advisor note that will definitely exceed the restricted width constraint of thirty characters and should therefore wrap across multiple lines rather than getting truncated.";
			const card = createAdvisorMessageCard({ notes: [{ note, severity: "concern" }] }, () => false, uiTheme);
			const text = strip(card.render(30));
			expect(text).toContain("truncated.");
		});
	});
	describe("formatSessionDumpText raw thinking", () => {
		it("does not nest literal thinking envelopes", () => {
			const md = formatSessionDumpText({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "thinking",
								thinking: "<thinking>\nCheck logs before accepting container health.\n</thinking>",
							},
						],
						timestamp: Date.now(),
					} as AgentMessage,
				],
				thinkingLevel: "high",
			});

			expect(md).toContain("Assistant: <thinking>\nCheck logs before accepting container health.\n</thinking>");
			expect(md).not.toContain("<thinking>\n<thinking>");
		});

		it("unwraps sibling literal thinking envelopes independently", () => {
			const md = formatSessionDumpText({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "<thinking>\nfirst\n</thinking>" },
							{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "file.ts" } },
							{ type: "thinking", thinking: "<thinking>\nsecond\n</thinking>" },
						],
						timestamp: Date.now(),
					} as AgentMessage,
				],
				tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
				thinkingLevel: "high",
			});

			expect(md).toContain("Assistant: <thinking>\nfirst\nsecond\n</thinking>");
			expect(md).not.toContain("first\n</thinking>\n<thinking>\nsecond");
		});
	});
});
