import type { ImageContent, TextContent } from "omk-ai";
import { createImmutableSnapshot } from "../plain-data.ts";
import { AgentHarnessError } from "./errors.ts";

export type QueuedSessionWrite<TMessage> =
	| { readonly type: "message"; readonly message: TMessage }
	| { readonly type: "thinking_level_change"; readonly thinkingLevel: string }
	| { readonly type: "model_change"; readonly provider: string; readonly modelId: string }
	| { readonly type: "active_tools_change"; readonly activeToolNames: string[] }
	| { readonly type: "custom"; readonly customType: string; readonly data?: unknown }
	| {
			readonly type: "custom_message";
			readonly customType: string;
			readonly content: string | (TextContent | ImageContent)[];
			readonly details?: unknown;
			readonly display: boolean;
	  }
	| { readonly type: "label"; readonly targetId: string; readonly label: string | undefined }
	| { readonly type: "session_info"; readonly name?: string }
	| { readonly type: "leaf"; readonly targetId: string | null };

interface SessionWritePort<TMessage> {
	getStorage(): { setLeafId(targetId: string | null): Promise<void> };
	appendMessage(message: TMessage): Promise<unknown>;
	appendThinkingLevelChange(thinkingLevel: string): Promise<unknown>;
	appendModelChange(provider: string, modelId: string): Promise<unknown>;
	appendActiveToolsChange(activeToolNames: string[]): Promise<unknown>;
	appendCustomEntry(customType: string, data?: unknown): Promise<unknown>;
	appendCustomMessageEntry(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: unknown,
	): Promise<unknown>;
	appendLabel(targetId: string, label: string | undefined): Promise<unknown>;
	appendSessionName(name: string): Promise<unknown>;
	moveTo(targetId: string | null): Promise<unknown>;
}

/** A queued write tagged with the monotonic order in which it was accepted. */
interface SequencedSessionWrite<TMessage> {
	readonly sequence: number;
	readonly write: QueuedSessionWrite<TMessage>;
}

/**
 * Owns ordered pending writes and serializes coordinator-routed persistence.
 *
 * Persistence follows *acceptance* order, not the queue contents observed when
 * a boundary finally runs. Each boundary captures a watermark at invocation
 * time and drains only writes accepted at or before it, so a write enqueued
 * after an idle boundary was reserved can never overtake it.
 */
export class SessionWriteCoordinator<TMessage> {
	private readonly pendingWrites: SequencedSessionWrite<TMessage>[] = [];
	private nextSequence = 1;
	private operationTail?: Promise<void>;
	private invokingOperation = false;
	private readonly session: SessionWritePort<TMessage>;

	constructor(session: SessionWritePort<TMessage>) {
		this.session = session;
	}

	enqueue(write: QueuedSessionWrite<TMessage>): void {
		this.pendingWrites.push({ sequence: this.nextSequence++, write: createImmutableSnapshot(write) });
	}

	hasPending(): boolean {
		return this.pendingWrites.length > 0;
	}

	snapshot(): readonly QueuedSessionWrite<TMessage>[] {
		// Each queued write was frozen on acceptance, so exposing them needs no clone.
		return Object.freeze(this.pendingWrites.map((entry) => entry.write));
	}

	async flush(): Promise<void> {
		const acceptedThrough = this.nextSequence - 1;
		await this.serialize(async () => await this.flushPendingThrough(acceptedThrough));
	}

	async persistAfterPending(write: QueuedSessionWrite<TMessage>): Promise<void> {
		const snapshot = createImmutableSnapshot(write);
		// Reserve the boundary now: only writes already accepted precede this one.
		const acceptedThrough = this.nextSequence - 1;
		await this.serialize(async () => {
			await this.flushPendingThrough(acceptedThrough);
			await this.persistIdleWrite(snapshot);
		});
	}

	/** Drains queued writes up to `acceptedThrough`; a failed head stays at the head. */
	private async flushPendingThrough(acceptedThrough: number): Promise<void> {
		while (this.pendingWrites.length > 0) {
			const head = this.pendingWrites[0];
			if (head === undefined || head.sequence > acceptedThrough) return;
			await this.persist(head.write);
			this.pendingWrites.shift();
		}
	}

	/** Idle leaf moves keep the summarizing `Session.moveTo()` path. */
	private async persistIdleWrite(write: QueuedSessionWrite<TMessage>): Promise<void> {
		if (write.type === "leaf") {
			await this.session.moveTo(write.targetId);
			return;
		}
		await this.persist(write);
	}

	private async persist(write: QueuedSessionWrite<TMessage>): Promise<void> {
		switch (write.type) {
			case "message":
				await this.session.appendMessage(write.message);
				return;
			case "thinking_level_change":
				await this.session.appendThinkingLevelChange(write.thinkingLevel);
				return;
			case "model_change":
				await this.session.appendModelChange(write.provider, write.modelId);
				return;
			case "active_tools_change":
				await this.session.appendActiveToolsChange([...write.activeToolNames]);
				return;
			case "custom":
				await this.session.appendCustomEntry(write.customType, write.data);
				return;
			case "custom_message":
				await this.session.appendCustomMessageEntry(
					write.customType,
					typeof write.content === "string" ? write.content : [...write.content],
					write.display,
					write.details,
				);
				return;
			case "label":
				await this.session.appendLabel(write.targetId, write.label);
				return;
			case "session_info":
				await this.session.appendSessionName(write.name ?? "");
				return;
			case "leaf":
				await this.session.getStorage().setLeafId(write.targetId);
				return;
			default: {
				const unsupportedWrite: never = write;
				throw new AgentHarnessError(
					"invalid_state",
					`Unsupported pending session write: ${String(unsupportedWrite)}`,
				);
			}
		}
	}

	private serialize(operation: () => Promise<void>): Promise<void> {
		if (this.invokingOperation) {
			throw new AgentHarnessError("invalid_state", "Session persistence cannot synchronously reenter itself");
		}
		const previous = this.operationTail;
		let releaseTail = (): void => undefined;
		const tail = new Promise<void>((resolve) => {
			releaseTail = resolve;
		});
		this.operationTail = tail;
		const invoke = (): Promise<void> => {
			this.invokingOperation = true;
			try {
				return operation();
			} finally {
				this.invokingOperation = false;
			}
		};
		const next = previous ? previous.then(invoke) : invoke();
		const release = (): void => {
			releaseTail();
			if (this.operationTail === tail) this.operationTail = undefined;
		};
		// Keep the serialization tail usable after a caller observes a failed write.
		void next.then(release, release);
		return next;
	}
}
