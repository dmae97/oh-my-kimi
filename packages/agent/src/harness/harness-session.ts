import type { ImageContent, TextContent } from "omk-ai";
import { createImmutableSnapshot } from "../plain-data.ts";
import { AgentHarnessError, toError } from "./errors.ts";
import type { QueuedSessionWrite, SessionWriteCoordinator } from "./session-write-coordinator.ts";

type FacadeWrite<TMessage> =
	| { readonly type: "message"; readonly message: TMessage }
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

interface SessionPort<TEntry, TContext, TMetadata> {
	getMetadata(): Promise<TMetadata>;
	getLeafId(): Promise<string | null>;
	getEntry(id: string): Promise<TEntry | undefined>;
	getEntries(): Promise<TEntry[]>;
	getBranch(fromId?: string): Promise<TEntry[]>;
	buildContext(): Promise<TContext>;
	getLabel(id: string): Promise<string | undefined>;
	getSessionName(): Promise<string | undefined>;
}

interface CustomMessageInput<T = unknown> {
	readonly customType: string;
	readonly content: string | readonly (TextContent | ImageContent)[];
	readonly display: boolean;
	readonly details?: T;
}

/**
 * Internal implementation of the public `HarnessSession` structural interface.
 *
 * This module intentionally imports no harness/session types. `AgentHarness` and the
 * raw session are in a legacy import-cycle component; importing their types here would
 * pull this new boundary into that component because the cycle ratchet treats static
 * type imports as architectural edges. Generic ports keep the implementation a leaf.
 */
export class HarnessSessionFacade<TMessage, TEntry, TContext, TMetadata> {
	private readonly session: SessionPort<TEntry, TContext, TMetadata>;
	private readonly getPhase: () => string;
	private readonly sessionWrites: SessionWriteCoordinator<TMessage>;

	constructor(
		session: SessionPort<TEntry, TContext, TMetadata>,
		getPhase: () => string,
		sessionWrites: SessionWriteCoordinator<TMessage>,
	) {
		this.session = session;
		this.getPhase = getPhase;
		this.sessionWrites = sessionWrites;
	}

	async getMetadata(): Promise<Readonly<TMetadata>> {
		return this.read(() => this.session.getMetadata());
	}

	async getLeafId(): Promise<string | null> {
		return this.read(() => this.session.getLeafId());
	}

	async getEntry(id: string): Promise<Readonly<TEntry> | undefined> {
		return this.read(() => this.session.getEntry(id));
	}

	async getEntries(): Promise<readonly Readonly<TEntry>[]> {
		return this.read(() => this.session.getEntries());
	}

	async getBranch(fromId?: string): Promise<readonly Readonly<TEntry>[]> {
		return this.read(() => this.session.getBranch(fromId));
	}

	async buildContext(): Promise<Readonly<TContext>> {
		return this.read(() => this.session.buildContext());
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.read(() => this.session.getLabel(id));
	}

	async getSessionName(): Promise<string | undefined> {
		return this.read(() => this.session.getSessionName());
	}

	getPendingWrites(): readonly QueuedSessionWrite<TMessage>[] {
		return this.sessionWrites.snapshot();
	}

	async appendMessage(message: TMessage): Promise<void> {
		await this.write(this.snapshot({ type: "message", message }));
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<void> {
		await this.write(this.snapshot({ type: "custom", customType, data }));
	}

	async appendCustomMessage<T = unknown>(input: CustomMessageInput<T>): Promise<void> {
		const write = this.snapshot({
			type: "custom_message",
			customType: input.customType,
			content: typeof input.content === "string" ? input.content : [...input.content],
			display: input.display,
			details: input.details,
		});
		await this.write(write);
	}

	async appendLabel(targetId: string, label: string | undefined): Promise<void> {
		if (!(await this.getEntry(targetId))) {
			throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
		}
		await this.write(this.snapshot({ type: "label", targetId, label }));
	}

	async appendSessionName(name: string): Promise<void> {
		await this.write(this.snapshot({ type: "session_info", name: name.trim() }));
	}

	async setLeafId(targetId: string | null): Promise<void> {
		if (targetId !== null && !(await this.getEntry(targetId))) {
			throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
		}
		await this.write(this.snapshot({ type: "leaf", targetId }));
	}

	private async read<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return createImmutableSnapshot(await operation());
		} catch (error) {
			throw new AgentHarnessError("session", "Session read failed", toError(error));
		}
	}

	private snapshot<TWrite extends FacadeWrite<TMessage>>(write: TWrite): TWrite {
		try {
			return createImmutableSnapshot(write);
		} catch (error) {
			throw new AgentHarnessError("invalid_argument", "Session writes must contain plain data", toError(error));
		}
	}

	private async write(write: FacadeWrite<TMessage>): Promise<void> {
		const phase = this.getPhase();
		if (phase === "turn") {
			this.sessionWrites.enqueue(write);
			return;
		}
		if (phase !== "idle") {
			throw new AgentHarnessError("invalid_state", `Cannot write session state during ${phase}`);
		}
		try {
			await this.sessionWrites.persistAfterPending(write);
		} catch (error) {
			if (error instanceof AgentHarnessError && error.code === "invalid_state") throw error;
			throw new AgentHarnessError("session", "Session write failed", toError(error));
		}
	}
}
