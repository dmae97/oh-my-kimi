import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, DeveloperMessage, Model, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai/types";

/**
 * Regression test for: "each tool_use must have a single result. Found multiple tool_result blocks with id"
 *
 * When an assistant message has stopReason "error" or "aborted" with tool calls,
 * and the agent-loop has already added tool results for those calls,
 * transformMessages should NOT add duplicate synthetic tool results.
 */
describe("Duplicate Tool Results Regression", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};

	it("should not duplicate tool results for errored messages when results already exist", () => {
		const toolCallId = "toolu_019xqMTvqWZiTDy8XxmjxrTo";

		// Simulate the message array that would be sent to the API:
		// 1. User message
		// 2. Assistant message with tool call (errored/aborted)
		// 3. Tool result (already added by agent-loop's createAbortedToolResult)
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: "read",
					arguments: { path: "/some/file.ts" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error", // Key: message is errored
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		};

		const existingToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "Tool execution was aborted." }],
			isError: true,
			timestamp: Date.now(),
		};

		const messages = [
			{
				role: "user" as const,
				content: "Read the file",
				timestamp: Date.now(),
			},
			assistantMessage,
			existingToolResult, // Already added by agent-loop
		];

		// Transform messages
		const transformed = transformMessages(messages, model);

		// Count tool results with the same ID
		const toolResults = transformed.filter(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === toolCallId,
		);

		// Should have exactly ONE tool result, not two
		expect(toolResults.length).toBe(1);
	});

	it("does not synthesize 'No result provided' when a real tool result appears later in history", () => {
		const toolCallId = "toolu_deferred_result_123";

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: "todo_write",
					arguments: { ops: [{ op: "update", id: "task-1", status: "completed" }] },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const messages = [
			assistantMessage,
			{
				role: "developer" as const,
				content: "Follow-up guidance between the call and result",
				timestamp: Date.now(),
			},
			{
				role: "toolResult" as const,
				toolCallId,
				toolName: "todo_write",
				content: [{ type: "text" as const, text: "todo updated" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const transformed = transformMessages(messages, model);
		const toolResults = transformed.filter(
			msg => msg.role === "toolResult" && (msg as ToolResultMessage).toolCallId === toolCallId,
		);

		expect(toolResults).toHaveLength(1);
		expect((toolResults[0] as ToolResultMessage).content).toEqual([{ type: "text", text: "todo updated" }]);
	});

	it("should not duplicate tool results for aborted messages when results already exist", () => {
		const toolCallId = "toolu_aborted_test_123";

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: "bash",
					arguments: { command: "echo hello" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted", // Key: message is aborted
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		};

		const existingToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "Tool execution was aborted." }],
			isError: true,
			timestamp: Date.now(),
		};

		const messages = [
			{
				role: "user" as const,
				content: "Run the command",
				timestamp: Date.now(),
			},
			assistantMessage,
			existingToolResult,
		];

		const transformed = transformMessages(messages, model);

		const toolResults = transformed.filter(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === toolCallId,
		);

		expect(toolResults.length).toBe(1);
	});

	it("should add synthetic tool results when none exist for errored messages", () => {
		const toolCallId = "toolu_no_result_123";

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: "edit",
					arguments: { path: "/some/file.ts", oldText: "foo", newText: "bar" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		};

		// No tool result exists
		const messages = [
			{
				role: "user" as const,
				content: "Edit the file",
				timestamp: Date.now(),
			},
			assistantMessage,
			// No tool result - transformMessages should add one
		];

		const transformed = transformMessages(messages, model);

		const toolResults = transformed.filter(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === toolCallId,
		);

		// Should have exactly ONE synthetic tool result added
		expect(toolResults.length).toBe(1);
	});

	it("should handle multiple tool calls in errored message with partial results", () => {
		const toolCallId1 = "toolu_multi_1";
		const toolCallId2 = "toolu_multi_2";
		const toolCallId3 = "toolu_multi_3";

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: toolCallId1, name: "read", arguments: { path: "/file1.ts" } },
				{ type: "toolCall", id: toolCallId2, name: "read", arguments: { path: "/file2.ts" } },
				{ type: "toolCall", id: toolCallId3, name: "read", arguments: { path: "/file3.ts" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		};

		// Only first tool has a result
		const existingToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCallId1,
			toolName: "read",
			content: [{ type: "text", text: "file1 content" }],
			isError: false,
			timestamp: Date.now(),
		};

		const messages = [
			{ role: "user" as const, content: "Read three files", timestamp: Date.now() },
			assistantMessage,
			existingToolResult,
		];

		const transformed = transformMessages(messages, model);

		// Should have exactly 3 tool results total
		const allToolResults = transformed.filter(m => m.role === "toolResult");
		expect(allToolResults.length).toBe(3);

		// Each tool call should have exactly one result
		const result1 = allToolResults.filter(m => (m as ToolResultMessage).toolCallId === toolCallId1);
		const result2 = allToolResults.filter(m => (m as ToolResultMessage).toolCallId === toolCallId2);
		const result3 = allToolResults.filter(m => (m as ToolResultMessage).toolCallId === toolCallId3);

		expect(result1.length).toBe(1);
		expect(result2.length).toBe(1);
		expect(result3.length).toBe(1);
	});
});

/**
 * Tests for Codex-style abort handling:
 * - Tool calls are preserved (not converted to text summaries)
 * - Synthetic "aborted" tool results are injected
 * - A <turn-aborted> guidance marker is added as synthetic user message
 */
describe("Codex-style Abort Handling", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};

	it("should preserve tool call structure in aborted messages", () => {
		const toolCallId = "toolu_preserve_test";

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me read that file" },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "/test.ts" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};

		const messages = [{ role: "user" as const, content: "Read the file", timestamp: Date.now() }, assistantMessage];

		const transformed = transformMessages(messages, model);

		// Find the assistant message
		const assistantMsg = transformed.find(m => m.role === "assistant") as AssistantMessage;
		expect(assistantMsg).toBeDefined();

		// Tool call should be preserved, not converted to text
		const toolCall = assistantMsg.content.find(b => b.type === "toolCall") as ToolCall;
		expect(toolCall).toBeDefined();
		expect(toolCall.id).toBe(toolCallId);
		expect(toolCall.name).toBe("read");

		// Text content should also be preserved
		const textContent = assistantMsg.content.find(b => b.type === "text");
		expect(textContent).toBeDefined();
	});

	it("should inject turn-aborted guidance marker as synthetic user message", () => {
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_marker_test", name: "bash", arguments: { command: "sleep 10" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Request was aborted",
			timestamp: 1000,
		};

		const messages = [{ role: "user" as const, content: "Run command", timestamp: 500 }, assistantMessage];

		const transformed = transformMessages(messages, model);

		// Should have: user, assistant, toolResult, developer(guidance)
		expect(transformed.length).toBe(4);

		// Last message should be the guidance marker
		const guidanceMsg = transformed[3] as DeveloperMessage;
		expect(guidanceMsg.role).toBe("developer");
		expect(guidanceMsg.content).toContain("<turn-aborted>");
		expect(guidanceMsg.content).toContain("verify current state before retrying");
	});

	it("should inject synthetic 'aborted' tool results with isError true", () => {
		const toolCallId = "toolu_synthetic_test";

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "edit", arguments: { path: "/file.ts" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};

		const messages = [{ role: "user" as const, content: "Edit file", timestamp: Date.now() }, assistantMessage];

		const transformed = transformMessages(messages, model);

		const toolResult = transformed.find(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === toolCallId,
		) as ToolResultMessage;

		expect(toolResult).toBeDefined();
		expect(toolResult.isError).toBe(true);
		expect(toolResult.content).toEqual([{ type: "text", text: "aborted" }]);
	});

	it("should preserve existing tool results for aborted messages when they were already recorded", () => {
		const toolCallId = "toolu_skip_existing";

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "/file.ts" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};

		const existingToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "Partial file content..." }],
			isError: false,
			timestamp: Date.now(),
		};

		const messages = [
			{ role: "user" as const, content: "Read file", timestamp: Date.now() },
			assistantMessage,
			existingToolResult,
		];

		const transformed = transformMessages(messages, model);

		const toolResults = transformed.filter(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === toolCallId,
		) as ToolResultMessage[];

		expect(toolResults.length).toBe(1);
		expect(toolResults[0].content).toEqual([{ type: "text", text: "Partial file content..." }]);
		expect(toolResults[0].isError).toBe(false);
	});
});
