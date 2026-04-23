import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	StopReason as BedrockStopReason,
	type Tool as BedrockTool,
	CachePointType,
	CacheTTL,
	type ContentBlock,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamMetadataEvent,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import { type DefaultProviderInit, defaultProvider } from "@aws-sdk/credential-provider-node";
import { $env, $flag } from "@oh-my-pi/pi-utils";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ProxyAgent } from "proxy-agent";
import type { Effort } from "../model-thinking";
import { mapEffortToAnthropicAdaptiveEffort, requireSupportedEffort } from "../model-thinking";
import { calculateCost } from "../models";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { normalizeToolCallId, resolveCacheRetention } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { appendRawHttpRequestDumpFor400, type RawHttpRequestDump, withHttpStatus } from "../utils/http-inspector";
import { parseStreamingJson } from "../utils/json-parse";
import { transformMessages } from "./transform-messages";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	reasoning?: Effort;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
}

type Block = (TextContent | ThinkingContent | ToolCall) & { index?: number; partialJson?: string };

const BEDROCK_PROXY_ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"];

function hasBedrockProxyEnvironment(): boolean {
	return BEDROCK_PROXY_ENV_KEYS.some(key => Boolean($env[key]?.trim()));
}

function installBedrockHttp1Transport(config: BedrockRuntimeClientConfig): void {
	const requestHandler = createBedrockHttp1RequestHandler();
	config.requestHandler = requestHandler;

	if (hasBedrockProxyEnvironment()) {
		config.credentialDefaultProvider = createBedrockCredentialDefaultProvider(requestHandler);
	}
}

function createBedrockHttp1RequestHandler(): NodeHttpHandler {
	if (!hasBedrockProxyEnvironment()) {
		return new NodeHttpHandler();
	}

	const agent = new ProxyAgent();
	return new NodeHttpHandler({
		httpAgent: agent,
		httpsAgent: agent,
	});
}

function createBedrockCredentialDefaultProvider(
	requestHandler: NodeHttpHandler,
): NonNullable<BedrockRuntimeClientConfig["credentialDefaultProvider"]> {
	return (init?: DefaultProviderInit) =>
		defaultProvider({
			...init,
			clientConfig: {
				...init?.clientConfig,
				requestHandler,
			},
		});
}

function isHttp2ResponseError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\bhttp2\b|http\/2/i.test(message);
}

export const streamBedrock: StreamFunction<"bedrock-converse-stream"> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream" as Api,
			provider: model.provider,
			model: model.id,
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

		const blocks = output.content as Block[];
		let rawRequestDump: RawHttpRequestDump | undefined;

		const config: BedrockRuntimeClientConfig = {
			region: options.region,
			profile: options.profile,
		};
		let usesHttp1RequestHandler = false;
		let messageStarted = false;

		// in Node.js/Bun environment only
		if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
			config.region = config.region || $env.AWS_REGION || $env.AWS_DEFAULT_REGION;

			// Support proxies that don't need authentication
			if ($flag("AWS_BEDROCK_SKIP_AUTH")) {
				config.credentials = {
					accessKeyId: "dummy-access-key",
					secretAccessKey: "dummy-secret-key",
				};
			}

			if ($flag("AWS_BEDROCK_FORCE_HTTP1") || hasBedrockProxyEnvironment()) {
				usesHttp1RequestHandler = true;
				installBedrockHttp1Transport(config);
			}
		}

		config.region = config.region || "us-east-1";

		try {
			const cacheRetention = resolveCacheRetention(options.cacheRetention);

			const toolConfig = convertToolConfig(context.tools, options.toolChoice);
			let additionalModelRequestFields = buildAdditionalModelRequestFields(model, options);

			// Bedrock rejects thinking + forced tool_choice ("any" or specific tool).
			// When tool_choice forces tool use, disable thinking to avoid API errors.
			if (toolConfig?.toolChoice && additionalModelRequestFields) {
				const tc = toolConfig.toolChoice;
				if ("any" in tc || "tool" in tc) {
					additionalModelRequestFields = undefined;
				}
			}

			const commandInput = {
				modelId: model.id,
				messages: convertMessages(context, model, cacheRetention),
				system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
				inferenceConfig: { maxTokens: options.maxTokens, temperature: options.temperature, topP: options.topP },
				toolConfig,
				additionalModelRequestFields,
			};
			options?.onPayload?.(commandInput);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: `https://bedrock-runtime.${config.region}.amazonaws.com/model/${model.id}/converse-stream`,
				body: commandInput,
			};

			while (true) {
				const client = new BedrockRuntimeClient(config);
				try {
					const command = new ConverseStreamCommand(commandInput);
					const response = await client.send(command, { abortSignal: options.signal });

					for await (const item of response.stream!) {
						if (item.messageStart) {
							messageStarted = true;
							if (item.messageStart.role !== ConversationRole.ASSISTANT) {
								throw new Error("Unexpected assistant message start but got user message start instead");
							}
							stream.push({ type: "start", partial: output });
						} else if (item.contentBlockStart) {
							if (!firstTokenTime) firstTokenTime = Date.now();
							handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
						} else if (item.contentBlockDelta) {
							if (!firstTokenTime) firstTokenTime = Date.now();
							handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
						} else if (item.contentBlockStop) {
							handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
						} else if (item.messageStop) {
							output.stopReason = mapStopReason(item.messageStop.stopReason);
						} else if (item.metadata) {
							handleMetadata(item.metadata, model, output);
						} else if (item.internalServerException) {
							throw new Error(`Internal server error: ${item.internalServerException.message}`);
						} else if (item.modelStreamErrorException) {
							throw new Error(`Model stream error: ${item.modelStreamErrorException.message}`);
						} else if (item.validationException) {
							throw withHttpStatus(new Error(`Validation error: ${item.validationException.message}`), 400);
						} else if (item.throttlingException) {
							throw new Error(`Throttling error: ${item.throttlingException.message}`);
						} else if (item.serviceUnavailableException) {
							throw new Error(`Service unavailable: ${item.serviceUnavailableException.message}`);
						}
					}
					break;
				} catch (error) {
					if (
						!usesHttp1RequestHandler &&
						!messageStarted &&
						output.content.length === 0 &&
						isHttp2ResponseError(error)
					) {
						usesHttp1RequestHandler = true;
						installBedrockHttp1Transport(config);
						continue;
					}
					throw error;
				} finally {
					client.destroy();
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error("An unknown error occurred");
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as Block).index;
				delete (block as Block).partialJson;
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			const baseMessage = error instanceof Error ? error.message : JSON.stringify(error);
			// Enrich error with thinking block diagnostics for signature-related failures
			let diagnostics = "";
			if (baseMessage.includes("signature") || baseMessage.includes("thinking")) {
				const thinkingBlocks = context.messages
					.filter((m): m is AssistantMessage => m.role === "assistant")
					.flatMap((m, mi) =>
						m.content
							.filter(b => b.type === "thinking")
							.map((b, bi) => ({
								msg: mi,
								block: bi,
								stop: m.stopReason,
								sigLen: b.thinkingSignature?.length ?? -1,
								thinkLen: b.thinking.length,
							})),
					);
				if (thinkingBlocks.length > 0) {
					diagnostics = `\n[thinking-diag] ${JSON.stringify(thinkingBlocks)}`;
				}
			}
			output.errorMessage = await appendRawHttpRequestDumpFor400(baseMessage + diagnostics, error, rawRequestDump);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: normalizeToolCallId(start.toolUse.toolUseId || ""),
			name: start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	let index = blocks.findIndex(b => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// If no text block exists yet, create one, as `handleContentBlockStart` is not sent for text blocks
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		block.arguments = parseStreamingJson(block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			if (delta.reasoningContent.signature) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
		}
	}
}

function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex(b => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	delete (block as Block).index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson);
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * Check if the model supports prompt caching.
 * Supported: Claude 3.5 Haiku, Claude 3.7 Sonnet, Claude 4.x+ models, Haiku 4.5+
 *
 * For base models and system-defined inference profiles the model ID / ARN
 * contains the model name, so we can decide locally.
 *
 * For application inference profiles (whose ARNs don't contain the model name),
 * set AWS_BEDROCK_FORCE_CACHE=1 to enable cache points.  Amazon Nova models
 * have automatic caching and don't need explicit cache points.
 */
function supportsPromptCaching(model: Model<"bedrock-converse-stream">): boolean {
	if (model.cost.cacheRead || model.cost.cacheWrite) return true;
	const id = model.id.toLowerCase();
	// Claude 4.x models (opus-4, sonnet-4, haiku-4)
	if (id.includes("claude") && (id.includes("-4-") || id.includes("-4."))) return true;
	// Claude 3.5 Haiku, Claude 3.7 Sonnet (legacy naming)
	if (id.includes("claude-3-7-sonnet") || id.includes("claude-3-5-haiku")) return true;
	// Claude Haiku 4.5+ (new naming)
	if (id.includes("claude-haiku")) return true;
	// Application inference profiles don't contain the model name in the ARN.
	// Allow users to force cache points via environment variable.
	if (typeof process !== "undefined" && $flag("AWS_BEDROCK_FORCE_CACHE")) return true;
	return false;
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Claude models support the signature field.
 * Other models (Nova, Titan, Mistral, Llama, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	return id.includes("anthropic.claude") || id.includes("anthropic/claude");
}

function buildSystemPrompt(
	systemPrompt: string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: SystemContentBlock[] = [{ text: systemPrompt.toWellFormed() }];

	// Add cache point for supported Claude models
	if (cacheRetention !== "none" && supportsPromptCaching(model)) {
		blocks.push({
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	return blocks;
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "developer":
			case "user":
				if (typeof m.content === "string") {
					// Skip empty user messages
					if (!m.content || m.content.trim() === "") continue;
					result.push({
						role: ConversationRole.USER,
						content: [{ text: m.content.toWellFormed() }],
					});
				} else {
					const contentBlocks = m.content
						.map(c => {
							switch (c.type) {
								case "text":
									return { text: c.text.toWellFormed() };
								case "image":
									return { image: createImageBlock(c.mimeType, c.data) };
								default:
									throw new Error("Unknown user content type");
							}
						})
						.filter(block => {
							// Filter out empty text blocks
							if ("text" in block && block.text) {
								return block.text.trim().length > 0;
							}
							return true; // Keep non-text blocks (images)
						});
					// Skip message if all blocks filtered out
					if (contentBlocks.length === 0) continue;
					result.push({
						role: ConversationRole.USER,
						content: contentBlocks,
					});
				}
				break;
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				if (m.content.length === 0) {
					continue;
				}
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text":
							// Skip empty text blocks
							if (c.text.trim().length === 0) continue;
							contentBlocks.push({ text: c.text.toWellFormed() });
							break;
						case "toolCall":
							contentBlocks.push({
								toolUse: {
									toolUseId: normalizeToolCallId(c.id),
									name: c.name,
									input: c.arguments,
								},
							});
							break;
						case "thinking":
							// Skip empty thinking blocks
							if (c.thinking.trim().length === 0) continue;
							// Thinking blocks require a valid signature when sent as reasoningContent.
							// If the signature is missing (e.g., from an aborted stream), or the model
							// doesn't support signatures, convert to plain text instead.
							if (supportsThinkingSignature(model) && c.thinkingSignature) {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: c.thinking.toWellFormed(), signature: c.thinkingSignature },
									},
								});
							} else if (!supportsThinkingSignature(model)) {
								// Model doesn't support signatures at all — send as unsigned reasoning
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: c.thinking.toWellFormed() },
									},
								});
							} else {
								// Model requires signature but we don't have one — demote to text
								contentBlocks.push({ text: `[Thinking]: ${c.thinking.toWellFormed()}` });
							}
							break;
						default:
							throw new Error("Unknown assistant content type");
					}
				}
				// Skip if all content blocks were filtered out
				if (contentBlocks.length === 0) {
					continue;
				}
				result.push({
					role: ConversationRole.ASSISTANT,
					content: contentBlocks,
				});
				break;
			}
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message
				// Bedrock requires all tool results to be in one message
				const toolResults: ContentBlock.ToolResultMember[] = [];

				// Add current tool result with all content blocks combined
				toolResults.push({
					toolResult: {
						toolUseId: normalizeToolCallId(m.toolCallId),
						content: m.content.map(c =>
							c.type === "image"
								? { image: createImageBlock(c.mimeType, c.data) }
								: { text: c.text.toWellFormed() },
						),
						status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
					},
				});

				// Look ahead for consecutive toolResult messages
				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: normalizeToolCallId(nextMsg.toolCallId),
							content: nextMsg.content.map(c =>
								c.type === "image"
									? { image: createImageBlock(c.mimeType, c.data) }
									: { text: c.text.toWellFormed() },
							),
							status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					j++;
				}

				// Skip the messages we've already processed
				i = j - 1;

				result.push({
					role: ConversationRole.USER,
					content: toolResults,
				});
				break;
			}
			default:
				throw new Error("Unknown message role");
		}
	}

	// Add cache point to the last user message for supported Claude models
	if (cacheRetention !== "none" && supportsPromptCaching(model) && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			(lastMessage.content as ContentBlock[]).push({
				cachePoint: {
					type: CachePointType.DEFAULT,
					...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
				},
			});
		}
	}

	return result;
}

function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
): ToolConfiguration | undefined {
	if (!tools?.length || toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map(tool => ({
		toolSpec: {
			name: tool.name,
			description: tool.description || "",
			inputSchema: { json: tool.parameters },
		},
	}));

	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return "stop";
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return "length";
		case BedrockStopReason.TOOL_USE:
			return "toolUse";
		default:
			return "error";
	}
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, any> | undefined {
	const reasoning = options.reasoning;
	if (!reasoning || !model.reasoning) {
		return undefined;
	}

	const mode = model.thinking?.mode;
	if (mode === "anthropic-adaptive") {
		const effort = mapEffortToAnthropicAdaptiveEffort(model, reasoning);
		return {
			thinking: { type: "adaptive" },
			output_config: { effort },
		};
	}

	const level = requireSupportedEffort(model, reasoning);
	const defaultBudgets: Record<Effort, number> = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
		xhigh: 32768,
	};
	const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[level];

	const result: Record<string, any> = {
		thinking: {
			type: "enabled",
			budget_tokens: budget,
		},
	};

	if (options.interleavedThinking) {
		result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
	}

	return result;
}

function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}

	return { source: { bytes }, format };
}
