/**
 * Subscriber fan-out with a self-wait barrier, extracted from `AgentHarness`.
 *
 * A listener that awaits the end of the very operation whose emission it is
 * blocking forms a cycle. The call that closes that cycle (`waitForIdle()`,
 * `abort()`) is always made during the listener's *synchronous* prologue — an
 * async function body runs synchronously up to its first `await` — so marking
 * just that window identifies callback-originated waits exactly, without
 * falsely rejecting an unrelated concurrent caller that runs later while the
 * listener's promise is merely pending.
 *
 * This module imports no harness or session types so it stays a leaf for the
 * import-cycle ratchet; the harness passes the current operation id in.
 */

import { AgentHarnessError } from "./errors.ts";
import { normalizeHarnessError } from "./operation-outcome.ts";

export type SubscriberListener<TEvent> = (event: TEvent, signal?: AbortSignal) => Promise<void> | void;

export class SubscriberFanout<TEvent extends { readonly type: string }> {
	private readonly listeners = new Set<SubscriberListener<TEvent>>();
	/** Non-zero only while a subscriber's synchronous prologue is on the stack. */
	private syncFrameDepth = 0;
	private operationId: string | undefined;
	private eventType: string | undefined;

	subscribe(listener: SubscriberListener<TEvent>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Deliver `event` to every subscriber in order; a throwing subscriber fails the emission as `hook`. */
	async emit(event: TEvent, currentOperationId: string | undefined, signal?: AbortSignal): Promise<void> {
		for (const listener of this.listeners) {
			const previousOperationId = this.operationId;
			const previousEventType = this.eventType;
			this.operationId = currentOperationId;
			this.eventType = event.type;
			let pending: Promise<unknown> | unknown;
			this.syncFrameDepth += 1;
			try {
				pending = listener(event, signal);
			} catch (error) {
				this.operationId = previousOperationId;
				this.eventType = previousEventType;
				throw normalizeHarnessError(error, "hook");
			} finally {
				this.syncFrameDepth -= 1;
			}
			try {
				await pending;
			} catch (error) {
				throw normalizeHarnessError(error, "hook");
			} finally {
				this.operationId = previousOperationId;
				this.eventType = previousEventType;
			}
		}
	}

	/**
	 * Fail closed when an awaited listener tries to wait on its own operation.
	 * Rejecting immediately turns a permanent deadlock into a classified error.
	 *
	 * Scope: this catches a wait issued from the listener's synchronous prologue,
	 * which covers `await harness.waitForIdle()` / `await harness.abort()`. A wait
	 * deferred behind an unrelated `await` inside the listener is not detected.
	 */
	assertNotSelfWait(api: string, currentOperationId: string | undefined): void {
		if (this.syncFrameDepth > 0 && currentOperationId !== undefined && currentOperationId === this.operationId) {
			throw new AgentHarnessError(
				"invalid_state",
				`${api} cannot await the current operation from an awaited ${this.eventType ?? "unknown"} callback`,
			);
		}
	}
}
