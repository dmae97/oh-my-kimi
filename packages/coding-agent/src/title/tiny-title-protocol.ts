import type { TinyTitleLocalModelKey } from "./tiny-models";

export type TinyTitleWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "generate"; id: string; modelKey: TinyTitleLocalModelKey; message: string }
	| { type: "close" };

export type TinyTitleWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "title"; id: string; title: string | null }
	| { type: "error"; id: string; error: string }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "closed" };

export interface TinyTitleTransport {
	send(message: TinyTitleWorkerOutbound): void;
	onMessage(handler: (message: TinyTitleWorkerInbound) => void): () => void;
	close(): void;
}
