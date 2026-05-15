/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-ai/models";
import { parseStreamingJson } from "@oh-my-pi/pi-ai/utils/json-parse";
import { readSseJson } from "@oh-my-pi/pi-utils";

// Create stream class matching ProxyMessageEventStream
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			event => event.type === "done" || event.type === "error",
			event => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

export interface ProxyStreamOptions extends SimpleStreamOptions {
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
export function streamProxy(model: Model, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		// Initialize the partial message that we'll build up from events
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "stop",
			content: [],
			api: model.api,
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
			timestamp: Date.now(),
		};

		let response: Response | null = null;
		const abortHandler = () => {
			const body = response?.body;
			if (body) {
				body.cancel("Request aborted by user").catch(() => {});
			}
		};
		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: {
						temperature: options.temperature,
						topP: options.topP,
						topK: options.topK,
						minP: options.minP,
						presencePenalty: options.presencePenalty,
						repetitionPenalty: options.repetitionPenalty,
						maxTokens: options.maxTokens,
						reasoning: options.reasoning,
					},
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// Couldn't parse error response
				}
				throw new Error(errorMessage);
			}

			let sawTerminalEvent = false;
			for await (const event of readSseJson<ProxyAssistantMessageEvent>(
				response.body as ReadableStream<Uint8Array>,
				options.signal,
			)) {
				const parsedEvent = processProxyEvent(model, event, partial);
				if (parsedEvent) {
					if (parsedEvent.type === "done" || parsedEvent.type === "error") {
						sawTerminalEvent = true;
					}
					stream.push(parsedEvent);
				}
			}

			if (options.signal?.aborted && !sawTerminalEvent) {
				const reason = options.signal.reason;
				throw reason instanceof Error ? reason : new Error(String(reason ?? "Request aborted"));
			}

			stream.end();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * Process a proxy event and update the partial message.
 */
function processProxyEvent(
	model: Model,
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };

		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			} satisfies ToolCall & { partialJson: string } as ToolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				(content as any).partialJson += proxyEvent.delta;
				content.arguments = parseStreamingJson((content as any).partialJson) || {};
				partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				delete (content as any).partialJson;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			calculateCost(model, partial.usage);
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			calculateCost(model, partial.usage);
			return { type: "error", reason: proxyEvent.reason, error: partial };
	}
}
