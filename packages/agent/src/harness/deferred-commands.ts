/**
 * Deferred harness commands: the callback-safe alternative to waiting on the
 * operation a callback is inside.
 *
 * A listener that awaits `waitForIdle()` or `abortAndWait()` for the operation
 * whose emission it is blocking forms a cycle: settlement awaits the listener
 * and the listener awaits settlement. `AgentHarness.runWhenIdle()` breaks that
 * cycle by enqueueing the work and returning a ref without waiting, so the
 * callback never depends on the operation it is inside.
 *
 * Commands run in registration order, only while the harness reports idle, and
 * each outcome is captured in the ref instead of rejecting — a deferred command
 * is nobody's caller, so an unhandled rejection would be invisible.
 */

export type DeferredCommandStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface DeferredHarnessCommand {
	/** Short label used in the ref and in diagnostics. */
	readonly name: string;
	/** Runs once the harness is idle. */
	run(): Promise<unknown> | unknown;
}

export interface DeferredCommandOutcome {
	readonly status: "completed" | "failed" | "cancelled";
	readonly value?: unknown;
	readonly error?: unknown;
}

export interface CommandRef {
	readonly commandId: string;
	readonly name: string;
	readonly status: DeferredCommandStatus;
	/** Settles once the command completed, failed, or was cancelled. Never rejects. */
	readonly done: Promise<DeferredCommandOutcome>;
	/**
	 * Cancel while the command is still queued. Returns false once it has started:
	 * a running command owns its own lifecycle (a deferred command that begins a
	 * harness operation is stopped through the normal abort path instead).
	 */
	cancel(): boolean;
}

interface Entry {
	readonly commandId: string;
	readonly name: string;
	readonly command: DeferredHarnessCommand;
	readonly done: Promise<DeferredCommandOutcome>;
	readonly resolveDone: (outcome: DeferredCommandOutcome) => void;
	status: DeferredCommandStatus;
}

export class DeferredCommandQueue {
	/** Insertion-ordered, so registration order is the execution order. */
	private readonly entries = new Map<string, Entry>();
	private readonly isIdle: () => boolean;
	private nextSequence = 0;
	private draining = false;

	constructor(isIdle: () => boolean) {
		this.isIdle = isIdle;
	}

	get size(): number {
		return this.entries.size;
	}

	enqueue(command: DeferredHarnessCommand): CommandRef {
		this.nextSequence += 1;
		const commandId = `cmd-${this.nextSequence}`;
		let resolveDone: (outcome: DeferredCommandOutcome) => void = () => undefined;
		const done = new Promise<DeferredCommandOutcome>((resolve) => {
			resolveDone = resolve;
		});
		const entry: Entry = {
			commandId,
			name: command.name,
			command,
			done,
			resolveDone,
			status: "queued",
		};
		this.entries.set(commandId, entry);
		// "When idle" includes now: an idle harness starts the command immediately,
		// while a busy one leaves it queued for the next idle transition.
		void this.drain();
		return {
			commandId,
			name: entry.name,
			get status() {
				return entry.status;
			},
			done,
			cancel: () => this.cancelEntry(entry),
		};
	}

	/** Run queued commands in order while the harness stays idle. Never throws. */
	async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			for (;;) {
				// A command may start a new operation; the rest of the queue then waits
				// for the next idle transition instead of reentering the lifecycle.
				if (!this.isIdle()) return;
				const entry = this.entries.values().next().value as Entry | undefined;
				if (entry === undefined) return;
				this.entries.delete(entry.commandId);
				entry.status = "running";
				try {
					const value = await entry.command.run();
					entry.status = "completed";
					entry.resolveDone({ status: "completed", value });
				} catch (error) {
					entry.status = "failed";
					entry.resolveDone({ status: "failed", error });
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private cancelEntry(entry: Entry): boolean {
		if (entry.status !== "queued") return false;
		this.entries.delete(entry.commandId);
		entry.status = "cancelled";
		entry.resolveDone({ status: "cancelled" });
		return true;
	}
}
