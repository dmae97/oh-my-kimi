import type { TinyTitleLocalModelKey } from "./models";

export type TinyTitleProgressStatus =
	| "initiate"
	| "download"
	| "progress"
	| "progress_total"
	| "done"
	| "ready"
	| "error";

export interface TinyTitleProgressFileState {
	loaded: number;
	total: number;
}

export interface TinyTitleProgressEvent {
	modelKey: TinyTitleLocalModelKey;
	status: TinyTitleProgressStatus;
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, TinyTitleProgressFileState>;
	task?: string;
	model?: string;
}

export type TinyTitleWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "generate"; id: string; modelKey: TinyTitleLocalModelKey; message: string }
	| { type: "download"; id: string; modelKey: TinyTitleLocalModelKey }
	| { type: "close" };

export type TinyTitleWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "title"; id: string; title: string | null }
	| { type: "downloaded"; id: string }
	| { type: "error"; id: string; error: string }
	| { type: "progress"; id: string; event: TinyTitleProgressEvent }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "closed" };

export interface TinyTitleTransport {
	send(message: TinyTitleWorkerOutbound): void;
	onMessage(handler: (message: TinyTitleWorkerInbound) => void): () => void;
	close(): void;
}
