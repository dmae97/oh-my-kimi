import * as fs from "node:fs/promises";
import type { FileEntry, SessionMessageEntry } from "../../session/session-manager";
import { parseSessionEntries } from "../../session/session-manager";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import type {
	RpcSubagentEventFrame,
	RpcSubagentFrame,
	RpcSubagentMessagesResult,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

export interface RpcSubagentTranscriptSelector {
	subagentId?: string;
	sessionFile?: string;
	fromByte?: number;
}

type RpcSubagentOutput = (frame: RpcSubagentFrame) => void;

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): AgentProgress["status"] {
	return status === "started" ? "running" : status;
}

export async function readRpcSubagentTranscript(sessionFile: string, fromByte = 0): Promise<RpcSubagentMessagesResult> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	const file = Bun.file(sessionFile);
	const { size } = await fs.stat(sessionFile);
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}

	const text = startByte >= size ? "" : await file.slice(startByte).text();
	const lastNewline = text.lastIndexOf("\n");
	const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
	const entries = completeText.length > 0 ? parseSessionEntries(completeText) : [];
	const nextByte = startByte + Buffer.byteLength(completeText, "utf8");

	return {
		sessionFile,
		fromByte: startByte,
		nextByte,
		reset,
		entries,
		messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
	};
}

export class RpcSubagentRegistry {
	#subagents = new Map<string, RpcSubagentSnapshot>();
	#unsubscribers: Array<() => void> = [];
	#output: RpcSubagentOutput;
	#subscriptionLevel: RpcSubagentSubscriptionLevel = "progress";

	constructor(eventBus: EventBus, output: RpcSubagentOutput) {
		this.#output = output;
		this.#unsubscribers.push(
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				this.handleLifecycle(data as SubagentLifecyclePayload);
			}),
			eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				this.handleProgress(data as SubagentProgressPayload);
			}),
			eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				this.handleEvent(data as SubagentEventPayload);
			}),
		);
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#subagents.clear();
	}

	setSubscriptionLevel(level: RpcSubagentSubscriptionLevel): void {
		this.#subscriptionLevel = level;
	}

	getSubscriptionLevel(): RpcSubagentSubscriptionLevel {
		return this.#subscriptionLevel;
	}

	getSubagents(): RpcSubagentSnapshot[] {
		return [...this.#subagents.values()].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
	}

	handleLifecycle(payload: SubagentLifecyclePayload): void {
		const existing = this.#subagents.get(payload.id);
		const snapshot: RpcSubagentSnapshot = {
			id: payload.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: payload.description ?? existing?.description,
			status: statusFromLifecycle(payload.status),
			task: existing?.task,
			assignment: existing?.assignment,
			sessionFile: payload.sessionFile ?? existing?.sessionFile,
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			lastUpdate: Date.now(),
			progress: existing?.progress,
		};
		this.#subagents.set(payload.id, snapshot);
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_lifecycle", payload });
		}
	}

	handleProgress(payload: SubagentProgressPayload): void {
		const progress = payload.progress;
		const existing = this.#subagents.get(progress.id);
		this.#subagents.set(progress.id, {
			id: progress.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: progress.description ?? existing?.description,
			status: progress.status,
			task: payload.task,
			assignment: payload.assignment,
			sessionFile: payload.sessionFile ?? existing?.sessionFile,
			lastUpdate: Date.now(),
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			progress,
		});
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_progress", payload });
		}
	}

	handleEvent(payload: SubagentEventPayload): void {
		if (this.#subscriptionLevel !== "events") return;
		this.#output({ type: "subagent_event", payload } satisfies RpcSubagentEventFrame);
	}

	resolveSessionFile(selector: RpcSubagentTranscriptSelector): string {
		if (selector.subagentId) {
			const snapshot = this.#subagents.get(selector.subagentId);
			if (!snapshot?.sessionFile) {
				throw new Error(`Unknown subagent or session file unavailable: ${selector.subagentId}`);
			}
			return snapshot.sessionFile;
		}

		if (selector.sessionFile) {
			for (const snapshot of this.#subagents.values()) {
				if (snapshot.sessionFile === selector.sessionFile) return selector.sessionFile;
			}
			throw new Error("Unknown subagent session file");
		}

		throw new Error("get_subagent_messages requires subagentId or sessionFile");
	}
}
