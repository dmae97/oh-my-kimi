import type { JsStatusEvent } from "./tool-bridge";

export type JsDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "status"; event: JsStatusEvent };

export interface SessionSnapshot {
	cwd: string;
	sessionId: string;
}

export interface RunErrorPayload {
	name?: string;
	message: string;
	stack?: string;
	isAbort?: boolean;
	isToolError?: boolean;
}

export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

export type WorkerInbound =
	| { type: "init"; snapshot: SessionSnapshot }
	| { type: "run"; runId: string; code: string; filename: string; snapshot: SessionSnapshot }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

export type WorkerOutbound =
	| { type: "ready" }
	| { type: "init-failed"; error: RunErrorPayload }
	| { type: "text"; runId: string; chunk: string }
	| { type: "display"; runId: string; output: JsDisplayOutput }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| { type: "result"; runId: string; ok: true }
	| { type: "result"; runId: string; ok: false; error: RunErrorPayload }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "closed" };

export interface Transport {
	send(msg: WorkerOutbound): void;
	onMessage(handler: (msg: WorkerInbound) => void): () => void;
	close(): void;
}
