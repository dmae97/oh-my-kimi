import type { ImageContent, TextContent } from "omk-ai";
import { createImmutableSnapshot } from "../plain-data.ts";
import { AgentHarnessError, toError } from "./errors.ts";

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

type PendingWrite<TMessage> =
	| FacadeWrite<TMessage>
	| { readonly type: "thinking_level_change"; readonly thinkingLevel: string }
	| { readonly type: "model_change"; readonly provider: string; readonly modelId: string }
	| { readonly type: "active_tools_change"; readonly activeToolNames: string[] }
	| {
			readonly type: "compaction";
			readonly summary: string;
			readonly firstKeptEntryId: string;
			readonly tokensBefore: number;
			readonly details?: unknown;
			readonly fromHook?: boolean;
	  }
	| {
			readonly type: "branch_summary";
			readonly fromId: string;
			readonly summary: string;
			readonly details?: unknown;
			readonly fromHook?: boolean;
	  };

interface SessionPort<TMessage, TEntry, TContext, TMetadata> {
	getMetadata(): Promise<TMetadata>;
	getLeafId(): Promise<string | null>;
	getEntry(id: string): Promise<TEntry | undefined>;
	getEntries(): Promise<TEntry[]>;
	getBranch(fromId?: string): Promise<TEntry[]>;
	buildContext(): Promise<TContext>;
	getLabel(id: string): Promise<string | undefined>;
	getSessionName(): Promise<string | undefined>;
	appendMessage(message: TMessage): Promise<string>;
	appendCustomEntry(customType: string, data?: unknown): Promise<string>;
	appendCustomMessageEntry(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: unknown,
	): Promise<string>;
	appendLabel(targetId: string, label: string | undefined): Promise<string>;
	appendSessionName(name: string): Promise<string>;
	moveTo(entryId: string | null): Promise<string | undefined>;
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
	private readonly session: SessionPort<TMessage, TEntry, TContext, TMetadata>;
	private readonly getPhase: () => string;
	private readonly pendingWrites: PendingWrite<TMessage>[];

	constructor(
		session: SessionPort<TMessage, TEntry, TContext, TMetadata>,
		getPhase: () => string,
		pendingWrites: PendingWrite<TMessage>[],
	) {
		this.session = session;
		this.getPhase = getPhase;
		this.pendingWrites = pendingWrites;
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

	getPendingWrites(): readonly PendingWrite<TMessage>[] {
		return createImmutableSnapshot(this.pendingWrites);
	}

	async appendMessage(message: TMessage): Promise<void> {
		const write = this.snapshot({ type: "message", message });
		await this.write(write, () => this.session.appendMessage(write.message));
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<void> {
		const write = this.snapshot({ type: "custom", customType, data });
		await this.write(write, () => this.session.appendCustomEntry(write.customType, write.data));
	}

	async appendCustomMessage<T = unknown>(input: CustomMessageInput<T>): Promise<void> {
		const write = this.snapshot({
			type: "custom_message",
			customType: input.customType,
			content: typeof input.content === "string" ? input.content : [...input.content],
			display: input.display,
			details: input.details,
		});
		await this.write(write, () =>
			this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details),
		);
	}

	async appendLabel(targetId: string, label: string | undefined): Promise<void> {
		if (!(await this.getEntry(targetId))) {
			throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
		}
		const write = this.snapshot({ type: "label", targetId, label });
		await this.write(write, () => this.session.appendLabel(write.targetId, write.label));
	}

	async appendSessionName(name: string): Promise<void> {
		const write = this.snapshot({ type: "session_info", name: name.trim() });
		await this.write(write, () => this.session.appendSessionName(write.name ?? ""));
	}

	async setLeafId(targetId: string | null): Promise<void> {
		if (targetId !== null && !(await this.getEntry(targetId))) {
			throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
		}
		const write = this.snapshot({ type: "leaf", targetId });
		await this.write(write, () => this.session.moveTo(write.targetId));
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

	private async write(write: FacadeWrite<TMessage>, persist: () => Promise<unknown>): Promise<void> {
		const phase = this.getPhase();
		if (phase === "turn") {
			this.pendingWrites.push(write);
			return;
		}
		if (phase !== "idle") {
			throw new AgentHarnessError("invalid_state", `Cannot write session state during ${phase}`);
		}
		try {
			await persist();
		} catch (error) {
			throw new AgentHarnessError("session", "Session write failed", toError(error));
		}
	}
}
