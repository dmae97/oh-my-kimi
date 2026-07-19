/**
 * Per-tool execution timeout and cancellation for the agent loop.
 *
 * The agent loop awaits each tool's `execute` promise at a single shared
 * chokepoint. A tool that ignores its `AbortSignal` and never settles would
 * otherwise stall the whole run. This module bounds that risk without process
 * killing: the real execute promise is raced against two terminal causes — a
 * per-call timeout timer and the parent run's abort — so an uncooperative tool
 * still yields an immediate, immutable terminal result.
 *
 * The child `AbortSignal` handed to the tool is best-effort cooperative
 * cancellation only; correctness comes from the race, not from the tool
 * honoring the signal. `AbortSignal.any()` is intentionally not used: the
 * parent-abort and timeout wiring is explicit so timer/listener disposal is
 * idempotent and runs on every outcome.
 *
 * A late settlement of the real promise (after the terminal cause already won)
 * is observed exactly once for audit only. It never emits a second tool result
 * or lifecycle end, never mutates the committed result, and — because the real
 * promise is wrapped so it never rejects — can never surface as an unhandled
 * rejection.
 */

import { createAbortedToolResult, createTimeoutToolResult } from "./tool-execution-boundary.ts";
import type {
	AgentLoopConfig,
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolExecutionPolicy,
	ToolLateSettlementOutcome,
	ToolTimeoutDisposition,
} from "./types.ts";

export type { ToolDispositionEnvelope } from "./tool-execution-boundary.ts";
export { createAbortedToolResult, createTimeoutToolResult } from "./tool-execution-boundary.ts";

/**
 * Resolve the effective {@link ToolExecutionPolicy} with the release default
 * `lateSettlement: "audit"`: late settlements are observable audit events
 * unless a caller explicitly opts out with `"ignore"`.
 */
export function resolveToolExecutionPolicy(policy: Partial<ToolExecutionPolicy> | undefined): ToolExecutionPolicy {
	return {
		...(policy?.timeoutMs === undefined ? {} : { timeoutMs: policy.timeoutMs }),
		...(policy?.cancelSiblingsOnFatal === undefined ? {} : { cancelSiblingsOnFatal: policy.cancelSiblingsOnFatal }),
		lateSettlement: policy?.lateSettlement === "ignore" ? "ignore" : "audit",
	};
}

/** Audit-only description of a real tool promise settling after its terminal cause won. */
export interface ToolLateSettlement {
	toolCallId: string;
	toolName: string;
	/** The terminal disposition that was already committed when the real promise settled. */
	disposition: ToolTimeoutDisposition;
	/** How the real tool promise eventually settled. Disposition-safe metadata only. */
	outcome: ToolLateSettlementOutcome;
}

/**
 * Resolve the effective per-call timeout with strict precedence:
 * per-tool `AgentTool.timeoutMs` > per-name `config.toolTimeouts[name]` >
 * global `config.toolTimeoutMs`.
 *
 * The first level that is *present* (not `undefined`) wins, so a per-tool `0`
 * deliberately disables the timeout even when a global default is set. A
 * resolved value that is absent, non-finite, or non-positive returns `0`, which
 * disables only the timer. Parent cancellation is still raced so an
 * uncooperative tool cannot keep an aborted run open.
 */
export function resolveToolTimeoutMs(
	tool: Pick<AgentTool<any>, "timeoutMs">,
	config: Pick<AgentLoopConfig, "toolTimeoutMs" | "toolTimeouts">,
	toolName: string,
): number {
	let chosen: number | undefined;
	if (tool.timeoutMs !== undefined) {
		chosen = tool.timeoutMs;
	} else if (config.toolTimeouts?.[toolName] !== undefined) {
		chosen = config.toolTimeouts[toolName];
	} else {
		chosen = config.toolTimeoutMs;
	}
	if (typeof chosen !== "number" || !Number.isFinite(chosen) || chosen <= 0) {
		return 0;
	}
	return chosen;
}

type TerminalCause = { kind: ToolTimeoutDisposition };

type RealSettlement<TDetails> =
	| { kind: "resolved"; result: AgentToolResult<TDetails> }
	| { kind: "rejected"; error: unknown };

export interface RunToolCallWithTimeoutOptions<TDetails = any> {
	toolCallId: string;
	toolName: string;
	/** Effective timeout in ms. A non-positive value disables the timer, not parent cancellation. */
	timeoutMs: number;
	/** Parent run abort signal, if any. */
	signal: AbortSignal | undefined;
	/** Start the real tool, passing the child (best-effort) signal and update sink. */
	start: (childSignal: AbortSignal, onUpdate: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>;
	/** Emit a `tool_execution_update` for a partial result observed before terminality. */
	emitUpdate: (partialResult: AgentToolResult<TDetails>) => Promise<void> | void;
	/** Emit the audit-only late-settlement event exactly once, after the terminal cause won. */
	emitLateSettlement: (settlement: ToolLateSettlement) => Promise<void> | void;
	/** Map a thrown/rejected tool error to a normal error result (real completion path). */
	toErrorResult: (error: unknown) => AgentToolResult<any>;
	/**
	 * Late-settlement policy (default `"audit"`). `"ignore"` drops the audit
	 * event; the committed terminal result is immutable under both policies.
	 */
	lateSettlement?: ToolExecutionPolicy["lateSettlement"];
}

export interface RunToolCallWithTimeoutResult {
	result: AgentToolResult<any>;
	isError: boolean;
	/** True when the tool's `execute` actually began before the result was committed. */
	executionStarted: boolean;
	/** Terminal cause when the runtime (not the tool) committed the result. */
	terminalDisposition?: ToolTimeoutDisposition;
}

/**
 * Race a tool's `execute` promise against a per-call timeout and parent abort.
 *
 * Control flow (single path, no `AbortSignal.any()`):
 * - A timer and a parent-abort listener each resolve one shared "terminal cause"
 *   deferred. Whichever fires first wins; resolving is idempotent.
 * - The timer callback resolves the timeout cause *before* aborting the child so
 *   a tool that rejects promptly on abort cannot make "aborted" win a timeout.
 * - `Promise.race` picks the real settlement or the terminal cause. Timer and
 *   listener disposal is idempotent and runs on every outcome.
 * - On a terminal-cause win, the real promise (wrapped so it never rejects) is
 *   observed once for the audit event and the committed result is immutable.
 */
export async function runToolCallWithTimeout<TDetails = any>(
	options: RunToolCallWithTimeoutOptions<TDetails>,
): Promise<RunToolCallWithTimeoutResult> {
	const { toolCallId, toolName, timeoutMs, signal, start, emitUpdate, emitLateSettlement, toErrorResult } = options;
	const lateSettlementPolicy = resolveToolExecutionPolicy({ lateSettlement: options.lateSettlement }).lateSettlement;

	// Defensive: a parent already aborted before execution starts never runs the
	// tool. prepareToolCall normally catches this earlier.
	if (signal?.aborted) {
		return {
			result: createAbortedToolResult(false),
			isError: true,
			executionStarted: false,
			terminalDisposition: "aborted",
		};
	}

	const childController = new AbortController();
	let raceSettled = false;
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	let resolveCause!: (cause: TerminalCause) => void;
	const causePromise = new Promise<TerminalCause>((resolve) => {
		resolveCause = resolve;
	});

	const abortChild = (reason: unknown): void => {
		if (!childController.signal.aborted) {
			childController.abort(reason);
		}
	};

	const onParentAbort = (): void => {
		// Resolve the terminal cause before aborting the child so the committed
		// disposition stays "aborted" even for a tool that rejects on its signal.
		resolveCause({ kind: "aborted" });
		abortChild(signal?.reason);
	};

	const dispose = (): void => {
		if (disposed) {
			return;
		}
		disposed = true;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		signal?.removeEventListener("abort", onParentAbort);
	};

	if (timeoutMs > 0) {
		timer = setTimeout(() => {
			// Reason ordering: settle the timeout cause first, then signal the child.
			resolveCause({ kind: "timeout" });
			abortChild(new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	}

	signal?.addEventListener("abort", onParentAbort, { once: true });

	// Updates are observation-only: deliver those seen before terminality, but
	// never let listener settlement or failure delay the terminal race.
	const gatedUpdate: AgentToolUpdateCallback<TDetails> = (partialResult) => {
		if (raceSettled) return;
		void Promise.resolve()
			.then(() => emitUpdate(partialResult))
			.catch(() => undefined);
	};

	// Wrap so a synchronous throw from `start` becomes a rejection and, crucially,
	// so this promise never rejects — both settlements map to a value. That makes
	// the late observer safe from unhandled rejections.
	const realSettled: Promise<RealSettlement<TDetails>> = (async () =>
		start(childController.signal, gatedUpdate))().then(
		(result) => ({ kind: "resolved" as const, result }),
		(error) => ({ kind: "rejected" as const, error }),
	);

	const raced = await Promise.race<
		{ from: "real"; settlement: RealSettlement<TDetails> } | { from: "cause"; cause: TerminalCause }
	>([
		realSettled.then((settlement) => ({ from: "real" as const, settlement })),
		causePromise.then((cause) => ({ from: "cause" as const, cause })),
	]);

	raceSettled = true;
	dispose();

	if (raced.from === "real") {
		// The tool settled first: behave exactly like the no-timeout path.
		const settlement = raced.settlement;
		if (settlement.kind === "resolved") {
			return { result: settlement.result, isError: false, executionStarted: true };
		}
		return { result: toErrorResult(settlement.error), isError: true, executionStarted: true };
	}

	// A terminal cause won. Observe the real promise's eventual settlement exactly
	// once for audit only; realSettled never rejects and the chained catch guards
	// against a throwing emit, so no unhandled rejection is possible. The
	// `"ignore"` policy drops the audit event but never the immutable result.
	const disposition = raced.cause.kind;
	if (lateSettlementPolicy === "audit") {
		realSettled
			.then((settlement) =>
				emitLateSettlement({
					toolCallId,
					toolName,
					disposition,
					outcome: settlement.kind === "resolved" ? "resolved" : "rejected",
				}),
			)
			.catch(() => {});
	}

	const result =
		disposition === "timeout" ? createTimeoutToolResult(toolName, timeoutMs) : createAbortedToolResult(true);
	return { result, isError: true, executionStarted: true, terminalDisposition: disposition };
}
