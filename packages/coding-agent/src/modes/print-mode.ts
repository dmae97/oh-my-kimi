/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `omk -p "prompt"` - text output
 * - `omk --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "omk-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { formatSessionTermination, type SessionTermination } from "../core/session-termination.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	let promptStarted = false;
	let latestTermination: SessionTermination | undefined;
	let renderedTermination: SessionTermination | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const renderTermination = (termination: SessionTermination): void => {
		if (termination.kind === "completed" || renderedTermination === termination) return;
		renderedTermination = termination;
		if (mode === "json") {
			writeRawStdout(`${JSON.stringify({ type: "session_termination", termination })}\n`);
		} else {
			console.error(formatSessionTermination(termination));
		}
	};

	const renderFailure = (fallback: string): void => {
		const termination = latestTermination ?? (!promptStarted ? session.lastTermination : undefined);
		if (termination && termination.kind !== "completed") {
			renderTermination(termination);
			return;
		}
		console.error(fallback);
	};

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: Array<"SIGTERM" | "SIGHUP"> = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				session.recordProcessSignal(signal);
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		promptStarted = false;
		latestTermination = undefined;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (event.type === "session_termination") {
				latestTermination = event.termination;
				if (mode === "text") {
					renderTermination(event.termination);
				} else {
					renderedTermination = event.termination;
				}
			}
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		});

		const startupTermination = session.lastTermination;
		if (startupTermination?.kind === "process_crash" && startupTermination.source === "inferred_on_resume") {
			renderTermination(startupTermination);
		}
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			promptStarted = true;
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			promptStarted = true;
			await session.prompt(message);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					renderFailure(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		renderFailure(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
