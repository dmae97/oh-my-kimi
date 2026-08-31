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

/** Owns ordered pending writes and serializes coordinator-routed persistence. */
export class SessionWriteCoordinator<TMessage> {
	private readonly pendingWrites: QueuedSessionWrite<TMessage>[] = [];
	private operationTail?: Promise<void>;
	private invokingOperation = false;
	private readonly session: SessionWritePort<TMessage>;

	constructor(session: SessionWritePort<TMessage>) {
		this.session = session;
	}

	enqueue(write: QueuedSessionWrite<TMessage>): void {
		this.pendingWrites.push(createImmutableSnapshot(write));
	}

	hasPending(): boolean {
		return this.pendingWrites.length > 0;
	}

	snapshot(): readonly QueuedSessionWrite<TMessage>[] {
		return createImmutableSnapshot(this.pendingWrites);
	}

	async flush(): Promise<void> {
		await this.serialize(async () => await this.flushPending());
	}

	async persistAfterPending(write: QueuedSessionWrite<TMessage>): Promise<void> {
		const snapshot = createImmutableSnapshot(write);
		await this.serialize(async () => await this.flushPending(snapshot));
	}

	private async flushPending(persistAfter?: QueuedSessionWrite<TMessage>): Promise<void> {
		while (this.pendingWrites.length > 0) {
			const write = this.pendingWrites[0];
			if (write === undefined) return;
			await this.persist(write);
			this.pendingWrites.shift();
		}
		if (persistAfter?.type === "leaf") {
			await this.session.moveTo(persistAfter.targetId);
		} else if (persistAfter) {
			await this.persist(persistAfter);
		}
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
