import type {
	SessionNotification,
	SessionUpdate,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { TodoStatus } from "../../tools/todo-write";

interface AcpEventMapperOptions {
	getMessageId?: (message: unknown) => string | undefined;
}

interface ContentArrayContainer {
	content?: unknown;
}

interface TypedValue {
	type?: unknown;
}

interface TextLikeContent extends TypedValue {
	text?: unknown;
}

interface BinaryLikeContent extends TypedValue {
	data?: unknown;
	mimeType?: unknown;
}

interface PathContainer {
	path?: unknown;
}

interface OldPathContainer {
	oldPath?: unknown;
}

interface NewPathContainer {
	newPath?: unknown;
}

interface CommandContainer {
	command?: unknown;
}

interface PatternContainer {
	pattern?: unknown;
}

interface QueryContainer {
	query?: unknown;
}

interface ErrorMessageContainer {
	errorMessage?: unknown;
}

interface MessageContainer {
	message?: unknown;
}

interface ResourceLinkLikeContent extends TypedValue {
	uri?: unknown;
	name?: unknown;
	title?: unknown;
	description?: unknown;
	mimeType?: unknown;
	size?: unknown;
}

interface BlobResourceLike {
	uri?: unknown;
	blob?: unknown;
	mimeType?: unknown;
}

interface TextResourceLike {
	uri?: unknown;
	text?: unknown;
	mimeType?: unknown;
}

interface EmbeddedResourceLikeContent extends TypedValue {
	resource?: unknown;
}

interface TextMessageLike {
	role?: unknown;
}

const ACP_TEXT_LIMIT = 4_000;

export function mapToolKind(toolName: string): ToolKind {
	switch (toolName) {
		case "read":
			return "read";
		case "write":
		case "edit":
			return "edit";
		case "delete":
			return "delete";
		case "move":
			return "move";
		case "bash":
		case "python":
			return "execute";
		case "search":
		case "find":
		case "ast_grep":
			return "search";
		case "web_search":
			return "fetch";
		case "todo_write":
			return "think";
		default:
			return "other";
	}
}

export function mapAgentSessionEventToAcpSessionUpdates(
	event: AgentSessionEvent,
	sessionId: string,
	options: AcpEventMapperOptions = {},
): SessionNotification[] {
	switch (event.type) {
		case "message_update":
			return mapAssistantMessageUpdate(event, sessionId, options);
		case "tool_execution_start": {
			const update: SessionUpdate = {
				sessionUpdate: "tool_call",
				toolCallId: event.toolCallId,
				title: buildToolTitle(event.toolName, event.args, event.intent),
				kind: mapToolKind(event.toolName),
				status: "pending",
				rawInput: event.args,
			};
			const locations = extractToolLocations(event.args);
			if (locations.length > 0) {
				update.locations = locations;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_update": {
			const content = extractToolCallContent(event.partialResult);
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: "in_progress",
				rawOutput: event.partialResult,
			};
			if (content.length > 0) {
				update.content = content;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_end": {
			const content = extractToolCallContent(event.result);
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: event.isError ? "failed" : "completed",
				rawOutput: event.result,
			};
			if (content.length > 0) {
				update.content = content;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "todo_reminder": {
			const entries = event.todos.map(todo => ({
				content: todo.content,
				priority: "medium" as const,
				status: mapTodoStatus(todo.status),
			}));
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries })];
		}
		case "todo_auto_clear":
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries: [] })];
		default:
			return [];
	}
}

function mapAssistantMessageUpdate(
	event: Extract<AgentSessionEvent, { type: "message_update" }>,
	sessionId: string,
	options: AcpEventMapperOptions,
): SessionNotification[] {
	if (!isAssistantMessage(event.message)) {
		return [];
	}

	let sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
	let text: string;
	switch (event.assistantMessageEvent.type) {
		case "text_delta":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.delta;
			break;
		case "thinking_delta":
			sessionUpdate = "agent_thought_chunk";
			text = event.assistantMessageEvent.delta;
			break;
		case "error":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.error.errorMessage ?? "Unknown error";
			break;
		default:
			return [];
	}
	if (text.length === 0) {
		return [];
	}

	const messageId = options.getMessageId?.(event.message);
	return [
		toSessionNotification(sessionId, {
			sessionUpdate,
			content: { type: "text", text },
			messageId,
		}),
	];
}

function toSessionNotification(sessionId: string, update: SessionUpdate): SessionNotification {
	return { sessionId, update };
}

const todoStatusMap: Record<TodoStatus, "pending" | "in_progress" | "completed"> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "completed",
	abandoned: "completed",
};

function mapTodoStatus(status: TodoStatus): "pending" | "in_progress" | "completed" {
	return todoStatusMap[status];
}

function buildToolTitle(toolName: string, args: unknown, intent: string | undefined): string {
	const trimmedIntent = intent?.trim();
	if (trimmedIntent) {
		return trimmedIntent;
	}

	const subject =
		extractStringProperty<PathContainer>(args, "path") ??
		extractStringProperty<CommandContainer>(args, "command") ??
		extractStringProperty<PatternContainer>(args, "pattern") ??
		extractStringProperty<QueryContainer>(args, "query");
	if (subject) {
		return `${toolName}: ${subject}`;
	}

	return toolName;
}

function extractToolLocations(args: unknown): ToolCallLocation[] {
	const locations: ToolCallLocation[] = [];
	const path = extractStringProperty<PathContainer>(args, "path");
	if (path) {
		locations.push({ path });
	}

	const oldPath = extractStringProperty<OldPathContainer>(args, "oldPath");
	if (oldPath && oldPath !== path) {
		locations.push({ path: oldPath });
	}

	const newPath = extractStringProperty<NewPathContainer>(args, "newPath");
	if (newPath && newPath !== path && newPath !== oldPath) {
		locations.push({ path: newPath });
	}

	return locations;
}

function extractToolCallContent(value: unknown): ToolCallContent[] {
	const richContent = extractStructuredToolCallContent(value);
	const fallbackText = extractReadableText(value);
	if (!fallbackText) {
		return richContent;
	}
	if (hasEquivalentTextContent(richContent, fallbackText)) {
		return richContent;
	}
	return [...richContent, textToolCallContent(fallbackText)];
}

function extractStructuredToolCallContent(value: unknown): ToolCallContent[] {
	const blocks = getContentBlocks(value);
	if (!blocks) {
		return [];
	}

	const content: ToolCallContent[] = [];
	for (const block of blocks) {
		const toolCallContent = toToolCallContent(block);
		if (toolCallContent) {
			content.push(toolCallContent);
		}
	}
	return content;
}

function getContentBlocks(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value !== "object" || value === null || !("content" in value)) {
		return undefined;
	}
	const content = (value as ContentArrayContainer).content;
	return Array.isArray(content) ? content : undefined;
}

function toToolCallContent(value: unknown): ToolCallContent | undefined {
	const type = getContentType(value);
	if (!type) {
		return undefined;
	}

	switch (type) {
		case "text": {
			const text = extractStructuredText(value);
			return text ? textToolCallContent(text) : undefined;
		}
		case "image":
		case "audio": {
			const data = extractStringProperty<BinaryLikeContent>(value, "data");
			const mimeType = extractStringProperty<BinaryLikeContent>(value, "mimeType");
			if (!data || !mimeType) {
				return undefined;
			}
			return {
				type: "content",
				content: {
					type,
					data,
					mimeType,
				},
			};
		}
		case "resource_link": {
			const uri = extractStringProperty<ResourceLinkLikeContent>(value, "uri");
			const name = extractStringProperty<ResourceLinkLikeContent>(value, "name");
			if (!uri || !name) {
				return undefined;
			}
			const resourceLinkContent: {
				type: "resource_link";
				uri: string;
				name: string;
				title?: string;
				description?: string;
				mimeType?: string;
				size?: number;
			} = {
				type: "resource_link",
				uri,
				name,
			};
			const title = extractStringProperty<ResourceLinkLikeContent>(value, "title");
			if (title) {
				resourceLinkContent.title = title;
			}
			const description = extractStringProperty<ResourceLinkLikeContent>(value, "description");
			if (description) {
				resourceLinkContent.description = description;
			}
			const mimeType = extractStringProperty<ResourceLinkLikeContent>(value, "mimeType");
			if (mimeType) {
				resourceLinkContent.mimeType = mimeType;
			}
			const size = extractNumberProperty<ResourceLinkLikeContent>(value, "size");
			if (size !== undefined) {
				resourceLinkContent.size = size;
			}
			return {
				type: "content",
				content: resourceLinkContent,
			};
		}
		case "resource": {
			const resource = extractEmbeddedResource(value);
			return resource
				? {
						type: "content",
						content: {
							type: "resource",
							resource,
						},
					}
				: undefined;
		}
		default:
			return undefined;
	}
}

function extractEmbeddedResource(
	value: unknown,
): { uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string } | undefined {
	if (typeof value !== "object" || value === null || !("resource" in value)) {
		return undefined;
	}

	const resource = (value as EmbeddedResourceLikeContent).resource;
	if (typeof resource !== "object" || resource === null) {
		return undefined;
	}

	const uri = extractStringProperty<TextResourceLike>(resource, "uri");
	if (!uri) {
		return undefined;
	}

	const text = extractStringProperty<TextResourceLike>(resource, "text");
	if (text) {
		const mimeType = extractStringProperty<TextResourceLike>(resource, "mimeType");
		return mimeType ? { uri, text, mimeType } : { uri, text };
	}

	const blob = extractStringProperty<BlobResourceLike>(resource, "blob");
	if (!blob) {
		return undefined;
	}
	const mimeType = extractStringProperty<BlobResourceLike>(resource, "mimeType");
	return mimeType ? { uri, blob, mimeType } : { uri, blob };
}

function textToolCallContent(text: string): ToolCallContent {
	return {
		type: "content",
		content: {
			type: "text",
			text,
		},
	};
}

function hasEquivalentTextContent(content: ToolCallContent[], text: string): boolean {
	return content.some(item => item.type === "content" && item.content.type === "text" && item.content.text === text);
}

function extractReadableText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return normalizeText(value);
	}
	if (value instanceof Error) {
		return normalizeText(value.message);
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const directText =
		extractStringProperty<TextLikeContent>(value, "text") ??
		extractStringProperty<ErrorMessageContainer>(value, "errorMessage") ??
		extractStringProperty<MessageContainer>(value, "message");
	if (directText) {
		return normalizeText(directText);
	}

	const contentBlocks = getContentBlocks(value);
	if (contentBlocks) {
		const text = contentBlocks
			.map(block => extractStructuredText(block))
			.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
			.join("\n");
		if (text.length > 0) {
			return normalizeText(text);
		}
	}

	const serialized = safeJsonStringify(value);
	return normalizeText(serialized);
}

function extractStructuredText(value: unknown): string | undefined {
	const text = extractStringProperty<TextLikeContent>(value, "text");
	if (!text) {
		return undefined;
	}
	return limitText(text);
}

function getContentType(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return undefined;
	}
	const type = (value as TypedValue).type;
	return typeof type === "string" ? type : undefined;
}

function extractStringProperty<T extends object>(value: unknown, key: keyof T): string | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "string" && property.length > 0 ? property : undefined;
}

function extractNumberProperty<T extends object>(value: unknown, key: keyof T): number | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function isAssistantMessage(value: unknown): boolean {
	return (
		typeof value === "object" && value !== null && "role" in value && (value as TextMessageLike).role === "assistant"
	);
}

function normalizeText(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const normalized = text.trim();
	return normalized.length > 0 ? limitText(normalized) : undefined;
}

function limitText(text: string): string {
	return text.length > ACP_TEXT_LIMIT ? `${text.slice(0, ACP_TEXT_LIMIT - 1)}…` : text;
}

function safeJsonStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}
