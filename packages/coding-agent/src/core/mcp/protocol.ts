/**
 * Pure JSON-RPC 2.0 framing for the MCP stdio transport.
 *
 * MCP stdio frames one JSON message per line on stdout; embedded newlines are
 * illegal, so decoding is a line split with a hard length ceiling. Nothing here
 * touches a process, a socket, or a clock — the transport owns all I/O so this
 * layer stays trivially testable.
 */

/** Ceiling for a single decoded line. A server that exceeds it is malfunctioning, not slow. */
export const MAX_MESSAGE_LINE_BYTES = 16 * 1024 * 1024;

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcErrorBody {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly result?: unknown;
	readonly error?: JsonRpcErrorBody;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
	if (!isRecord(message) || message.jsonrpc !== "2.0") return false;
	if (!("id" in message)) return false;
	const id = message.id;
	if (typeof id !== "number" && typeof id !== "string") return false;
	return "result" in message || "error" in message;
}

export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
	return isRecord(message) && message.jsonrpc === "2.0" && typeof message.method === "string" && !("id" in message);
}

export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
	if (!isRecord(message) || message.jsonrpc !== "2.0") return false;
	if (typeof message.method !== "string") return false;
	const id = message.id;
	return typeof id === "number" || typeof id === "string";
}

/** Serialize one message as a single stdio frame (JSON + newline). */
export function encodeMessage(message: JsonRpcMessage): string {
	const line = JSON.stringify(message);
	if (line.includes("\n")) {
		// JSON.stringify escapes newlines, so this is unreachable for valid input;
		// keep the guard so a future custom serializer cannot corrupt framing.
		throw new Error("MCP frame contains a literal newline");
	}
	return `${line}\n`;
}

export interface DecodedLine {
	/** Parsed message, when the line was valid JSON. */
	readonly message?: JsonRpcMessage;
	/** Why the line was dropped, when it was not usable. */
	readonly error?: string;
}

/**
 * Incremental newline-delimited JSON decoder.
 *
 * Holds at most one partial line. A line longer than {@link MAX_MESSAGE_LINE_BYTES}
 * is dropped with an error rather than buffered, so a runaway server cannot
 * exhaust memory.
 */
export function createLineDecoder(maxLineBytes: number = MAX_MESSAGE_LINE_BYTES): {
	push(chunk: string): DecodedLine[];
	reset(): void;
} {
	let buffer = "";
	let overflowed = false;

	return {
		push(chunk: string): DecodedLine[] {
			const out: DecodedLine[] = [];
			buffer += chunk;

			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (overflowed) {
					// The oversized line ends here; resume clean at the next boundary.
					overflowed = false;
				} else if (line.length > 0) {
					out.push(decodeLine(line));
				}
				newlineIndex = buffer.indexOf("\n");
			}

			if (!overflowed && buffer.length > maxLineBytes) {
				out.push({ error: `MCP frame exceeded ${maxLineBytes} bytes` });
				overflowed = true;
				buffer = "";
			}
			return out;
		},
		reset(): void {
			buffer = "";
			overflowed = false;
		},
	};
}

function decodeLine(line: string): DecodedLine {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { error: "MCP frame is not valid JSON" };
	}
	if (isJsonRpcResponse(parsed) || isJsonRpcNotification(parsed) || isJsonRpcRequest(parsed)) {
		return { message: parsed };
	}
	return { error: "MCP frame is not a JSON-RPC 2.0 message" };
}

/** Format a JSON-RPC error body for a human or a model. */
export function formatJsonRpcError(error: JsonRpcErrorBody): string {
	const suffix = error.data === undefined ? "" : ` (${JSON.stringify(error.data)})`;
	return `JSON-RPC error ${error.code}: ${error.message}${suffix}`;
}
