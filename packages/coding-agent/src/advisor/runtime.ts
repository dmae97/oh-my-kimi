import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { obfuscateToolArguments, type SecretObfuscator } from "../secrets/obfuscator";
import { formatSessionHistoryMarkdown, PRIMARY_CONTEXT_CUSTOM_TYPES } from "../session/session-history-format";

/**
 * Minimal slice of `Agent` the runtime drives — satisfied by pi-agent-core
 * `Agent`. `state.error` mirrors `Agent.state.error`: provider/stream failures
 * the loop catches internally never reject `prompt()`, so the runtime reads
 * this field after every prompt to detect a failed turn.
 */
export interface AdvisorAgent {
	prompt(input: string): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;
	/**
	 * Drop messages appended past `count`. Called after a failed `prompt()` so a
	 * retry doesn't replay the failed user batch + synthetic assistant-error
	 * turn `Agent.#runLoop` records on its internal state.
	 */
	rollbackTo?(count: number): void;
	readonly state: { messages: AgentMessage[]; error?: string };
}

export interface AdvisorRuntimeHost {
	/** Live primary transcript (use `agent.state.messages`). */
	snapshotMessages(): AgentMessage[];
	/** Surface one advice note to the primary (enqueues into the session YieldQueue). */
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	/** Redact primary transcript bytes before they reach the advisor model. */
	obfuscator?: SecretObfuscator;
	/**
	 * Pre-prompt context maintenance for the advisor's own append-only context.
	 * Promotes the advisor model to a larger sibling when its context nears the
	 * window (mirroring the primary's promote-first policy) and resolves `true`
	 * when the advisor should re-prime — reset and replay the current
	 * primary-bounded transcript — because promotion did not free enough room.
	 * Optional: hosts that omit it get no maintenance (context only shrinks when
	 * the primary's next compaction triggers {@link AdvisorRuntime.reset}).
	 */
	maintainContext?(incomingTokens: number): Promise<boolean>;
	/**
	 * Called immediately before each `agent.prompt(batch)` cycle. Lets the host
	 * clear per-update advisor state — currently the one-advise-per-update gate
	 * in {@link AdvisorEmissionGuard}, which the host owns because it is the
	 * one that routes `advise()` results back to the primary.
	 */
	beginAdvisorUpdate?(): void;
	/**
	 * Called with the error of every failed advisor turn, before the retry sleep
	 * or the dropped-after-3 path. Lets the host apply credential-level remedies
	 * the advisor loop lacks: the in-stream a/b/c auth retry rotates through
	 * sibling credentials within one request but never blocks the LAST failing
	 * one — the primary agent's retry pipeline does that via
	 * `markUsageLimitReached`, so without this hook the advisor re-picks the
	 * same usage-limited account on every retry. Errors thrown here are logged
	 * and swallowed.
	 */
	onTurnError?(error: unknown): Promise<boolean | undefined> | undefined;
	/** Surface a non-recovering advisor failure to the host UI without adding model-visible context. */
	notifyFailure?(error: unknown): void;
	/** Signal that the advisor hit a quota/rate-limit. The host should update
	 *  the status indicator to `quota_exhausted`; the runtime will auto-resume
	 *  after its cooldown elapses. */
	notifyQuotaExhausted?(): void;
}

const ADVISOR_QUARANTINE_PREFIX = "Advisor response quarantined";

/** Signals that an advisor response was discarded before it could become model-visible context. */
export class AdvisorOutputQuarantinedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdvisorOutputQuarantinedError";
	}
}

interface AdvisorOutputHazard {
	label: string;
	pattern: RegExp;
}

const ADVISOR_OUTPUT_ONLY_HAZARDS: readonly AdvisorOutputHazard[] = [
	{ label: "account-deletion claim", pattern: /\buser\b.{0,80}\b(?:deleted|erased)\b.{0,80}\baccount\b/i },
	{
		label: "instruction override",
		pattern: /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/i,
	},
	{
		label: "destructive shell command",
		pattern: /\brm\s+(?=(?:-[a-z]+\s*)*-[a-z]*r[a-z]*)(?=(?:-[a-z]+\s*)*-[a-z]*f[a-z]*)(?:-[a-z]+\s*)+/i,
	},
	{ label: "denial instruction", pattern: /\bdeny\s+(?:this|it|the\s+request)\s+if\s+(?:asked|questioned)\b/i },
];

/**
 * Replaces an advisor assistant turn that requested unavailable tools or generated
 * output-only destructive directives with a sanitized error before dispatch.
 *
 * The agent loop records assistant turns before dispatching tools. Without this
 * pre-dispatch rewrite, an advisor hallucination can leave unrelated text in the
 * advisor transcript even though the action itself never executes.
 */
export function quarantineAdvisorUnsafeOutput(
	message: AssistantMessage,
	availableToolNames: ReadonlySet<string>,
	sourceText = "",
): string | undefined {
	const reasons: string[] = [];
	const unavailableToolNames = new Set<string>();
	const generatedParts: string[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall" && !availableToolNames.has(block.name)) unavailableToolNames.add(block.name);
		if (block.type === "toolCall" && block.name === "advise" && typeof block.arguments.note === "string") {
			generatedParts.push(block.arguments.note);
		}
		if (block.type === "text") generatedParts.push(block.text);
	}
	if (unavailableToolNames.size > 0) {
		const names = [...unavailableToolNames].sort();
		const toolLabel = names.length === 1 ? "tool" : "tools";
		reasons.push(`requested unavailable ${toolLabel} ${names.join(", ")}`);
	}

	const generatedText = generatedParts.join("\n");
	if (generatedText) {
		const labels: string[] = [];
		const matchedLabels: string[] = [];
		for (const hazard of ADVISOR_OUTPUT_ONLY_HAZARDS) {
			if (!hazard.pattern.test(generatedText)) continue;
			matchedLabels.push(hazard.label);
			if (!hazard.pattern.test(sourceText)) labels.push(hazard.label);
		}
		// A transcript can quote a destructive command while the advisor turns it
		// into a new instruction. The output-only override remains sufficient
		// provenance to quarantine that combination.
		if (
			matchedLabels.includes("destructive shell command") &&
			labels.includes("instruction override") &&
			!labels.includes("destructive shell command")
		) {
			labels.push("destructive shell command");
		}
		if (labels.includes("destructive shell command") || labels.length >= 3) {
			reasons.push(`generated output-only destructive directives: ${labels.join(", ")}`);
		}
	}

	if (reasons.length === 0) return undefined;

	const messageText = `${ADVISOR_QUARANTINE_PREFIX}: ${reasons.join("; ")}`;
	message.content = [{ type: "text", text: messageText }];
	message.stopReason = "error";
	message.stopDetails = undefined;
	message.toolCallAbortMessages = undefined;
	message.providerPayload = undefined;
	message.errorMessage = messageText;
	return messageText;
}

/**
 * Builds the provenance text used to decide whether hazardous advisor output was
 * generated by the advisor or came from model-visible primary/tool context.
 */
export function buildAdvisorQuarantineSourceText(currentInput: string, messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	if (currentInput) parts.push(currentInput);
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}
/**
 * Maximum number of late-arrival coalescing rounds in {@link AdvisorRuntime.#collectAndMaintainBatch}.
 * After this many rounds any items still in `#pending` are left for the next drain iteration
 * so a pathologically fast primary + slow `maintainContext` cannot stall dispatch indefinitely.
 */
const MAX_COALESCE_ROUNDS = 3;

interface PendingDelta {
	text: string;
	turns: number;
	/** Whether the primary was mid-turn (willContinue:true) when this delta was rendered. */
	wip: boolean;
}

interface CatchupWaiter {
	threshold: number;
	resolve: () => void;
	finish: () => void;
	timer?: NodeJS.Timeout;
}

/**
 * Classify a provider error as quota/rate-limit exhaustion. These errors are
 * transient but persist for minutes (until the quota window resets), so the
 * runtime pauses the advisor and auto-resumes after a cooldown instead of
 * burning 3 retries and dropping the backlog.
 */
function isQuotaError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /\b(quota|rate.?limit|429|insufficient_quota|usage.?limit|credit)\b/i.test(msg);
}
export class AdvisorRuntime {
	#lastCount = 0;
	/** Last-shown body, keyed by primary-context customType (plan/goal mode rules,
	 *  approved plan). These prompts are re-injected verbatim every primary turn;
	 *  this lets {@link #renderDelta} collapse an unchanged copy to a one-line
	 *  marker so the advisor isn't re-fed the full ~1k-token rules each turn.
	 *  Cleared on every re-prime/seed and when a failed batch is dropped. */
	#seenContext = new Map<string, string>();
	#pending: PendingDelta[] = [];
	#busy = false;
	#backlog = 0;
	#consecutiveFailures = 0;
	#failureNotified = false;
	#latestMessages?: AgentMessage[];
	#waiters: CatchupWaiter[] = [];
	/** Bumped by every external {@link reset}/{@link dispose}. A drain iteration
	 *  captures it before its awaits; a mismatch on resume means a reset aborted
	 *  the in-flight advisor prompt, so the stale batch is dropped instead of
	 *  being retried/requeued into the post-reset conversation. */
	#epoch = 0;
	disposed = false;
	/** Quota/rate-limit pause state. When `true`, the advisor stops processing
	 *  turns and drops new deltas until an explicit {@link reset} clears it
	 *  (triggered by `/new`, config rebuild, or session restart). There is no
	 *  timer-based auto-resume: provider quota windows (5h/7d) are far longer
	 *  than any reasonable timer, and premature retries waste calls and
	 *  re-trigger the same error. */
	#quotaExhausted = false;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
		private readonly retryDelayMs = 1000,
	) {}

	get backlog(): number {
		return this.#backlog;
	}
	get quotaExhausted(): boolean {
		return this.#quotaExhausted;
	}
	get failureNotified(): boolean {
		return this.#failureNotified;
	}

	/**
	 * True when `#pending` is non-empty while the drain loop is busy — i.e., newer
	 * primary turns arrived after the current batch's transcript window was fixed
	 * but before the advisor model finished processing it. The delivery path uses
	 * this to annotate advice that was generated without seeing those newer turns.
	 * Can be true during `agent.prompt()`, a `maintainContext` await, or a retry
	 * sleep — any time `#drain` is busy and a concurrent `onTurnEnd` pushed.
	 */
	get hasFreshBacklog(): boolean {
		return this.#pending.length > 0;
	}

	/**
	 * Called after each primary turn ends. Renders the incremental delta and
	 * queues it for the advisor model.
	 *
	 * @param messages - Live primary transcript snapshot (defaults to `snapshotMessages()`).
	 * @param opts.willContinue - When `true` the primary is mid-turn (more tool-call
	 *   steps will follow). The rendered heading is tagged `[in progress]` so the
	 *   advisor knows to withhold critique on partial work. The flag is carried on
	 *   the delta and forwarded to the reprime path so it is never silently dropped.
	 */
	onTurnEnd(messages?: AgentMessage[], opts?: { willContinue?: boolean }): void {
		if (this.disposed || this.#quotaExhausted) return;
		const all = messages ?? this.host.snapshotMessages();
		this.#latestMessages = all;
		const wip = opts?.willContinue ?? false;
		const render = this.#renderDelta(all, wip);
		if (render) {
			this.#pending.push({ text: render, turns: 1, wip });
			this.#backlog++;
			this.#notifyWaiters();
			void this.#drain();
		}
	}

	waitForCatchup(maxMs: number, threshold: number, signal?: AbortSignal): Promise<void> {
		if (this.disposed || signal?.aborted || this.#backlog < threshold || this.#quotaExhausted)
			return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		let waiter!: CatchupWaiter;
		const finish = (): void => {
			const idx = this.#waiters.indexOf(waiter);
			if (idx >= 0) this.#waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		waiter = { threshold, resolve, finish, timer: setTimeout(finish, maxMs) };
		this.#waiters.push(waiter);
		signal?.addEventListener("abort", finish, { once: true });
		if (signal?.aborted) {
			finish();
		}
		return promise;
	}

	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#wakeAllWaiters();
		try {
			this.agent.abort("advisor disposed");
		} catch {}
	}

	#resetAdvisorContext(clearBacklog: boolean, wakeWaiters: boolean): void {
		this.#lastCount = 0;
		this.#pending = [];
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#seenContext.clear();
		if (clearBacklog) {
			this.#backlog = 0;
		}
		if (wakeWaiters) {
			this.#wakeAllWaiters();
		}
		try {
			this.agent.reset();
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	/**
	 * Re-prime the advisor after a history rewrite (compaction, session
	 * switch/resume, branch). Clears the advisor's own (non-persisted) context
	 * and rewinds the cursor to 0 so the NEXT turn replays the full current —
	 * post-compaction — transcript, giving the advisor fresh context instead of
	 * leaving it blind to everything before the rewrite.
	 */
	reset(): void {
		this.#epoch++;
		this.#quotaExhausted = false;
		this.#resetAdvisorContext(true, true);
	}

	/**
	 * Seed the cursor to the current transcript length when the advisor is enabled
	 * mid-session. Prevents the next turn from replaying the entire history to the
	 * advisor (which would be expensive and likely stale).
	 */
	seedTo(count: number): void {
		this.#lastCount = count;
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#seenContext.clear();
		this.#wakeAllWaiters();
	}

	#renderDelta(messages?: AgentMessage[], wip = false): string | null {
		const all = messages ?? this.#latestMessages ?? this.host.snapshotMessages();
		if (all.length < this.#lastCount) {
			this.#lastCount = all.length;
			this.#seenContext.clear();
			return null;
		}
		const delta = all
			.slice(this.#lastCount)
			.filter(m => !(m.role === "custom" && m.customType === "advisor"))
			.map(m => this.#dedupContextMessage(m));
		this.#lastCount = all.length;
		if (delta.length === 0) return null;
		const obfuscator = this.host.obfuscator;
		const formattedDelta = obfuscator?.hasSecrets() ? obfuscateAdvisorDelta(obfuscator, delta) : delta;
		const md = formatSessionHistoryMarkdown(formattedDelta, {
			includeThinking: true,
			includeToolIntent: true,
			watchedRoles: true,
			expandPrimaryContext: true,
			expandEditDiffs: true,
		});
		if (!md.trim()) return null;
		const heading = wip ? "### Session update [in progress — more steps follow]" : "### Session update";
		return `${heading}\n\n${md}`;
	}

	/**
	 * Collapse a re-injected primary-context prompt (plan/goal mode rules, the
	 * approved plan) to a short marker when its body is byte-identical to the
	 * copy already shown to the advisor since the last re-prime. The primary
	 * re-injects these verbatim every turn; without this the advisor re-reads the
	 * full rules (~1k tokens) each turn. Returns a CLONE when collapsing — the
	 * input shares the live primary transcript and must never be mutated.
	 */
	#dedupContextMessage(msg: AgentMessage): AgentMessage {
		if (msg.role !== "custom") return msg;
		// Narrowed to CustomMessage: customType and content are properly typed.
		if (!PRIMARY_CONTEXT_CUSTOM_TYPES.has(msg.customType)) return msg;
		if (typeof msg.content !== "string") return msg;
		if (this.#seenContext.get(msg.customType) === msg.content) {
			return { ...msg, content: "(unchanged — still in effect)" };
		}
		this.#seenContext.set(msg.customType, msg.content);
		return msg;
	}

	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.#backlog < w.threshold) {
				w.finish();
			}
		}
	}

	#wakeAllWaiters(): void {
		for (const w of [...this.#waiters]) {
			w.finish();
		}
	}

	/**
	 * Drop the user batch + synthetic assistant-error turn `Agent.#runLoop`
	 * appended for a failed prompt so a retry replays a clean baseline and the
	 * dropped-after-3 path never leaks orphan failures into the next successful
	 * run. Prefers the agent's own `rollbackTo` (which also re-syncs its
	 * append-only context); falls back to truncating `state.messages` for tests
	 * that hand-roll a minimal facade.
	 */
	#rollbackFailedTurn(snapshot: number): void {
		const messages = this.agent.state.messages;
		if (messages.length <= snapshot) return;
		try {
			if (this.agent.rollbackTo) {
				this.agent.rollbackTo(snapshot);
				return;
			}
			messages.length = snapshot;
		} catch (err) {
			logger.debug("advisor rollback failed", { err: String(err) });
		}
	}

	/**
	 * Collect all currently pending deltas into one batch, running
	 * `maintainContext` for correct token budgeting. Loops until the pending
	 * queue is stable (no new deltas arrived during a maintenance check) or a
	 * reprime is triggered. Every `await` inside the loop has an epoch guard so
	 * a reset/dispose mid-await cannot leak a stale batch into the post-reset
	 * conversation.
	 *
	 * The coalescing loop is capped at {@link MAX_COALESCE_ROUNDS} iterations so
	 * a pathologically fast primary combined with a slow `maintainContext` cannot
	 * stall dispatch indefinitely — any items still in `#pending` after the cap
	 * are left for the next drain iteration.
	 *
	 * Returns `null` when the epoch was invalidated — caller should `continue`.
	 * Returns `{ batch: null, finalTurns }` when there is nothing to render but
	 * backlog still needs to be decremented.
	 */
	async #collectAndMaintainBatch(
		epoch: number,
	): Promise<{ batch: string | null; finalTurns: number; wip: boolean } | null> {
		const initial = this.#pending.splice(0);
		let batchText = initial.map(b => b.text).join("\n\n");
		let turns = initial.reduce((sum, b) => sum + b.turns, 0);
		// Track WIP state of the most recent delta — forwarded to the reprime
		// #renderDelta so a willContinue:true turn keeps its [in progress] heading
		// even when the full transcript is replayed from scratch. Also returned to
		// #drain so the retry-requeue path preserves it on failed turns.
		let wip = initial.at(-1)?.wip ?? false;

		for (let round = 0; round < MAX_COALESCE_ROUNDS; round++) {
			if (this.host.maintainContext) {
				const incomingTokens = estimateTokens({ role: "user", content: batchText, timestamp: Date.now() });
				let shouldReprime = false;
				try {
					shouldReprime = await this.host.maintainContext(incomingTokens);
				} catch (err) {
					logger.debug("advisor context maintenance failed", { err: String(err) });
				}
				// Epoch guard — a reset/dispose during the maintainContext await
				// invalidates this batch.
				if (this.#epoch !== epoch) return null;

				if (shouldReprime) {
					// Tally deltas that arrived during this await before #resetAdvisorContext
					// wipes #pending, so finalTurns stays accurate for backlog accounting.
					// Also capture the latest WIP state before the queue is cleared.
					const lateItems = this.#pending.splice(0);
					turns += lateItems.reduce((sum, b) => sum + b.turns, 0);
					if (lateItems.length > 0) wip = lateItems.at(-1)!.wip;
					this.#resetAdvisorContext(false, false);
					return { batch: this.#renderDelta(this.#latestMessages, wip), finalTurns: turns, wip };
				}
			}

			// On the final round stop here — any late arrivals would ship without
			// a subsequent maintainContext budget check. Leave them in #pending for
			// the next drain iteration where they will be properly budgeted.
			if (round === MAX_COALESCE_ROUNDS - 1) break;

			// Coalesce any deltas that arrived while we were awaiting maintenance.
			// If none arrived the batch is stable and we're done; otherwise merge,
			// update WIP state, and re-check the maintenance budget.
			const late = this.#pending.splice(0);
			if (late.length === 0) break;
			batchText = [batchText, ...late.map(b => b.text)].join("\n\n");
			turns += late.reduce((sum, b) => sum + b.turns, 0);
			wip = late.at(-1)!.wip;
		}

		return { batch: batchText || null, finalTurns: turns, wip };
	}

	async #drain(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			while (!this.disposed && this.#pending.length) {
				const epoch = this.#epoch;
				const result = await this.#collectAndMaintainBatch(epoch);

				// Epoch was invalidated during batch collection; restart the loop.
				if (result === null) continue;

				const { batch, finalTurns, wip } = result;

				if (this.disposed || batch === null) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
				}

				let success = false;
				// Capture the advisor's message count BEFORE the prompt so a failure can
				// roll back the user batch + synthetic assistant-error turn Agent.#runLoop
				// appends to internal state. Without this, a retry would replay the failed
				// batch on top of stale turns and the dropped-after-3 path would leak
				// orphan failures into the next successful run's context.
				const messageSnapshot = this.agent.state.messages.length;
				try {
					// Reset the host's per-update advisor state (one-advise-per-update
					// gate) before each model cycle so the new batch starts fresh.
					this.host.beginAdvisorUpdate?.();
					await this.agent.prompt(batch);
					// Agent.#runLoop catches provider/stream failures internally and
					// resolves prompt() cleanly with stopReason: "error". Treat that
					// as a failed turn so endpoint rejections trip the retry path.
					const promptError = this.agent.state.error;
					if (promptError) throw new Error(promptError);
					// A content-less stop is a deliberate silent review — the documented
					// verifier behavior ("prefer silence when the agent is on track") — and
					// completes the turn. Sessions can legitimately have nothing to advise
					// on for any number of consecutive turns, so silence is never warned
					// about (#5216 did, spamming "Advisor unavailable" at quiet models).
					const turnError = getAdvisorTurnError(this.agent.state.messages.slice(messageSnapshot));
					if (turnError) throw turnError;
					success = true;
					this.#consecutiveFailures = 0;
					this.#failureNotified = false;
				} catch (err) {
					// reset()/dispose() aborts the in-flight prompt; treat it as a
					// reset, not a transient failure — drop the stale batch.
					if (this.#epoch !== epoch) continue;
					this.#rollbackFailedTurn(messageSnapshot);
					if (isQuotaError(err)) {
						logger.warn("advisor quota exhausted", { err: String(err) });
						// Call the usage-limit hook so AgentSession can block the
						// exhausted credential via markUsageLimitReached before pausing.
						// When the hook returns true, a sibling credential is available
						// now — retry immediately instead of entering quota pause.
						let switched = false;
						try {
							switched = (await this.host.onTurnError?.(err)) === true;
						} catch (hookErr) {
							logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
						}
						if (switched) {
							// Sibling credential available — retry once with the new key.
							const retrySnapshot = this.agent.state.messages.length;
							try {
								this.host.beginAdvisorUpdate?.();
								await this.agent.prompt(batch);
								const retryError = this.agent.state.error;
								if (retryError) throw new Error(retryError);
								success = true;
								this.#consecutiveFailures = 0;
								this.#failureNotified = false;
							} catch (retryErr) {
								this.#rollbackFailedTurn(retrySnapshot);
								if (this.#epoch !== epoch) continue;
								if (isQuotaError(retryErr)) {
									// Second quota on the sibling credential — mark it too,
									// then enter quota pause (both credentials exhausted).
									logger.warn("advisor quota exhausted on switched credential", { err: String(retryErr) });
									try {
										await this.host.onTurnError?.(retryErr);
									} catch (hookErr) {
										logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
									}
									if (this.#epoch !== epoch) continue;
									this.#quotaExhausted = true;
									this.#consecutiveFailures = 0;
									this.#failureNotified = false;
									this.#seenContext.clear();
									this.#pending.unshift({ text: batch, turns: finalTurns, wip });
									this.#wakeAllWaiters();
									try {
										this.host.notifyQuotaExhausted?.();
									} catch (notifyErr) {
										logger.warn("advisor quota notification failed", { err: String(notifyErr) });
									}
									break;
								}
								// Non-quota transient error on the retry — route through
								// onTurnError like every failed turn, then use the generic
								// failure/requeue/notify path.
								logger.debug("advisor switched retry failed with non-quota error", { err: String(retryErr) });
								try {
									await this.host.onTurnError?.(retryErr);
								} catch (hookErr) {
									logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
								}
								if (this.#epoch !== epoch) continue;
								this.#consecutiveFailures++;
								if (this.#consecutiveFailures >= 3) {
									logger.warn("advisor failed consecutively 3 times; dropping backlog to prevent stall");
									if (!this.#failureNotified) {
										this.#failureNotified = true;
										try {
											this.host.notifyFailure?.(retryErr);
										} catch (notifyErr) {
											logger.warn("advisor failure notification failed", { err: String(notifyErr) });
										}
									}
									this.#consecutiveFailures = 0;
									this.#seenContext.clear();
									success = true;
								} else {
									this.#pending.unshift({ text: batch, turns: finalTurns, wip });
									await Bun.sleep(this.retryDelayMs);
								}
							}
						} else {
							this.#quotaExhausted = true;
							this.#consecutiveFailures = 0;
							this.#failureNotified = false;
							this.#seenContext.clear();
							this.#pending.unshift({ text: batch, turns: finalTurns, wip });
							// Release catchup waiters: a quota-paused advisor can't make
							// progress, so waitForCatchup must not block the primary agent.
							this.#wakeAllWaiters();
							try {
								this.host.notifyQuotaExhausted?.();
							} catch (notifyErr) {
								logger.warn("advisor quota notification failed", { err: String(notifyErr) });
							}
							break;
						}
					} else {
						logger.debug("advisor turn failed", { err: String(err) });
						try {
							await this.host.onTurnError?.(err);
						} catch (hookErr) {
							logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
						}
						if (err instanceof AdvisorOutputQuarantinedError) {
							const rePrime = this.#pending.length > 0 ? this.#latestMessages : undefined;
							// Wake catchup waiters only when nothing is re-primed; otherwise the
							// re-primed turn restores the backlog and waiters resolve on its completion.
							this.#resetAdvisorContext(true, !rePrime);
							if (rePrime) this.onTurnEnd(rePrime);
							continue;
						}
						// The hook awaits; a reset during it invalidates this batch like the
						// prompt await above — drop it instead of requeueing stale content.
						if (this.#epoch !== epoch) continue;
						this.#consecutiveFailures++;
						if (this.#consecutiveFailures >= 3) {
							logger.warn("advisor failed consecutively 3 times; dropping backlog to prevent stall");
							if (!this.#failureNotified) {
								this.#failureNotified = true;
								try {
									this.host.notifyFailure?.(err);
								} catch (notifyErr) {
									logger.warn("advisor failure notification failed", { err: String(notifyErr) });
								}
							}
							this.#consecutiveFailures = 0;
							// Drop the seen-context so the next turn re-expands primary-context
							// prompts instead of marking them "unchanged" against content the
							// advisor never received.
							this.#seenContext.clear();
							success = true;
						} else {
							this.#pending.unshift({ text: batch, turns: finalTurns, wip });
							await Bun.sleep(this.retryDelayMs);
						}
					}
				}

				if (success && this.#epoch === epoch) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
				}
			}
		} finally {
			this.#busy = false;
		}
	}
}

/**
 * The only malformed advisor turn shape: the prompt resolved but produced no
 * assistant response at all. Everything an assistant message carries — advice,
 * reasoning, or deliberate silence (empty `stop`) — is a completed review.
 */
function getAdvisorTurnError(messages: readonly AgentMessage[]): Error | undefined {
	if (messages.length === 0) return undefined;
	if (messages.some(message => message.role === "assistant")) return undefined;
	return new Error("Advisor turn ended without an assistant response");
}

type TextualContent = string | readonly (TextContent | ImageContent)[];

function obfuscateTextualContent(obfuscator: SecretObfuscator, content: TextualContent): TextualContent {
	if (typeof content === "string") return obfuscator.obfuscate(content);
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

function obfuscateAssistantMessage(obfuscator: SecretObfuscator, message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscator.obfuscate(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "toolCall") {
			const args = obfuscateToolArguments(obfuscator, block.arguments);
			if (args === block.arguments) return block;
			changed = true;
			return { ...block, arguments: args };
		}
		return block;
	});
	return changed ? { ...message, content } : message;
}

function obfuscateDetails(
	obfuscator: SecretObfuscator,
	details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!details) return details;
	// Walk strings at every depth: `customOneLiner` renders nested fields
	// (e.g. `async-result` reads `details.jobs[].label`/`jobId`), so a shallow
	// pass leaks any secret a background job's label happens to contain.
	return obfuscateToolArguments(obfuscator, details);
}

function obfuscateAdvisorMessage(obfuscator: SecretObfuscator, message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer": {
			const content = obfuscateTextualContent(obfuscator, message.content as TextualContent);
			return content === message.content ? message : ({ ...(message as object), content } as AgentMessage);
		}
		case "toolResult": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content);
			const details = obfuscateDetails(obfuscator, msg.details);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "assistant":
			return obfuscateAssistantMessage(obfuscator, message as AssistantMessage) as AgentMessage;
		case "custom":
		case "hookMessage": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content);
			const details = obfuscateDetails(obfuscator, msg.details);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "bashExecution": {
			const msg = message as AgentMessage & { command: string; output: string };
			const command = obfuscator.obfuscate(msg.command);
			const output = obfuscator.obfuscate(msg.output);
			return command === msg.command && output === msg.output
				? message
				: ({ ...(message as object), command, output } as AgentMessage);
		}
		case "pythonExecution": {
			const msg = message as AgentMessage & { code: string; output: string };
			const code = obfuscator.obfuscate(msg.code);
			const output = obfuscator.obfuscate(msg.output);
			return code === msg.code && output === msg.output
				? message
				: ({ ...(message as object), code, output } as AgentMessage);
		}
		case "branchSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "compactionSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "fileMention": {
			const msg = message as AgentMessage & {
				files: Array<{ path: string; content: string; image?: unknown }>;
			};
			let changed = false;
			const files = msg.files.map(file => {
				const path = obfuscator.obfuscate(file.path);
				const content = obfuscator.obfuscate(file.content);
				if (path === file.path && content === file.content) return file;
				changed = true;
				return { ...file, path, content };
			});
			return changed ? ({ ...(message as object), files } as AgentMessage) : message;
		}
		default:
			return message;
	}
}

function obfuscateAdvisorDelta(obfuscator: SecretObfuscator, messages: AgentMessage[]): AgentMessage[] {
	let changed = false;
	const result = messages.map(message => {
		const next = obfuscateAdvisorMessage(obfuscator, message);
		if (next !== message) changed = true;
		return next;
	});
	return changed ? result : messages;
}
