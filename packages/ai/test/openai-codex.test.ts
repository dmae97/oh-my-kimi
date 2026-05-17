import { describe, expect, it } from "bun:test";
import { type RequestBody, transformRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import { parseCodexError } from "@oh-my-pi/pi-ai/providers/openai-codex/response-handler";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { createCodexModel } from "./helpers";

const DEFAULT_PROMPT_PREFIX =
	"You are an expert coding assistant. You help users with coding tasks by reading files, executing commands";

describe("openai-codex tool schemas", () => {
	it("adds empty properties to no-argument object parameter schemas", () => {
		const tools: Tool[] = [
			{
				name: "list_outgoing_messages",
				description: "List outgoing messages",
				parameters: { type: "object" },
			},
		];

		const converted = convertOpenAICodexResponsesTools(tools, createCodexModel("gpt-5.1-codex"));

		expect(converted[0]).toEqual({
			type: "function",
			name: "list_outgoing_messages",
			description: "List outgoing messages",
			parameters: { type: "object", properties: {} },
		});
	});
});

describe("openai-codex request transformer", () => {
	it("filters item_reference and strips ids", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
			input: [
				{
					type: "message",
					role: "developer",
					id: "sys-1",
					content: [{ type: "input_text", text: `${DEFAULT_PROMPT_PREFIX}...` }],
				},
				{
					type: "message",
					role: "user",
					id: "user-1",
					content: [{ type: "input_text", text: "hello" }],
				},
				{ type: "item_reference", id: "ref-1" },
				{ type: "function_call_output", call_id: "missing", name: "tool", output: "result" },
			],
			tools: [{ type: "function", name: "tool", description: "", parameters: {} }],
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), {});

		expect(transformed.store).toBe(false);
		expect(transformed.stream).toBe(true);
		expect(transformed.include).toEqual(["reasoning.encrypted_content"]);

		const input = transformed.input || [];
		expect(input.some(item => item.type === "item_reference")).toBe(false);
		expect(input.some(item => "id" in item)).toBe(false);
		const first = input[0];
		expect(first?.type).toBe("message");
		expect(first?.role).toBe("developer");
		expect(first?.content).toEqual([{ type: "input_text", text: `${DEFAULT_PROMPT_PREFIX}...` }]);

		const orphaned = input.find(item => item.type === "message" && item.role === "assistant");
		expect(orphaned?.content).toMatch(/Previous tool result/);
	});
});

describe("openai-codex reasoning effort validation", () => {
	it("rejects gpt-5.1 xhigh when metadata does not list it", async () => {
		const body: RequestBody = { model: "gpt-5.1", input: [] };
		await expect(
			transformRequestBody(body, createCodexModel(body.model), { reasoningEffort: "xhigh" }),
		).rejects.toThrow(/Supported efforts: minimal, low, medium, high/);
	});

	it("rejects unsupported Codex mini efforts instead of clamping", async () => {
		const body: RequestBody = { model: "gpt-5.1-codex-mini", input: [] };

		await expect(
			transformRequestBody({ ...body }, createCodexModel(body.model), { reasoningEffort: "low" }),
		).rejects.toThrow(/Supported efforts: medium, high/);

		await expect(
			transformRequestBody({ ...body }, createCodexModel(body.model), { reasoningEffort: "xhigh" }),
		).rejects.toThrow(/Supported efforts: medium, high/);
	});
});

describe("openai-codex error parsing", () => {
	it("produces friendly usage-limit messages and rate limits", async () => {
		const resetAt = Math.floor(Date.now() / 1000) + 600;
		const response = new Response(
			JSON.stringify({
				error: { code: "usage_limit_reached", plan_type: "Plus", resets_at: resetAt },
			}),
			{
				status: 429,
				headers: {
					"x-codex-primary-used-percent": "99",
					"x-codex-primary-window-minutes": "60",
					"x-codex-primary-reset-at": String(resetAt),
				},
			},
		);

		const info = await parseCodexError(response);
		expect(info.friendlyMessage?.toLowerCase()).toContain("usage limit");
		expect(info.rateLimits?.primary?.used_percent).toBe(99);
	});
});
