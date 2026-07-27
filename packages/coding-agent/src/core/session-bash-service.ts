/**
 * Session bash service: command execution, result recording, abort, and the
 * streaming-deferral queue. Extracted from AgentSession so the session class
 * coordinates lifecycle while this owns the bash surface end-to-end.
 *
 * Ordering contract (preserved from the session implementation):
 * - results recorded while the agent is streaming are queued and flushed on
 *   turn end (`flushPending`) so tool_use/tool_result ordering never breaks;
 * - `recordBashResult` is idempotent-safe to call from executeBash and from
 *   extensions that run bash themselves.
 */
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { classifyShellCommand } from "./command-safety.ts";
import {
	buildBlockedBashResult,
	evaluateCommandGate,
	isCommandSafetyAssumeYesEnabled,
} from "./extensions/builtin/command-safety-gate.ts";
import type { LoadoutAccessPolicy } from "./loadout-access-policy.ts";
import { assertLoadoutAccess, decideLoadoutAccess } from "./loadout-access-policy.ts";
import type { BashExecutionMessage } from "./messages.ts";
import type { SessionBashRuntime } from "./session-bash-runtime.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { type BashOperations, type BashSandboxPreflight, createLocalBashOperations } from "./tools/bash.ts";

export interface ExecuteBashOptions {
	excludeFromContext?: boolean;
	/** Optional identifier echoed in `bash_execution_update` events (RPC request correlation). */
	id?: string;
	operations?: BashOperations;
	safetyGate?: "headless";
	/** Trusted internal/test override for local bash sandboxing. */
	sandboxPolicy?: BashSandboxPreflight;
}

export interface SessionBashServiceDeps {
	readonly settings: SettingsManager;
	readonly runtime: SessionBashRuntime;
	readonly loadoutPolicy: LoadoutAccessPolicy | undefined;
	readonly getCwd: () => string;
	readonly emit: (event: { type: "bash_execution_update"; id?: string; delta: string }) => void;
	readonly isStreaming: () => boolean;
	readonly pushMessage: (message: BashExecutionMessage) => void;
	readonly appendMessage: (message: BashExecutionMessage) => void;
}

function isSandboxDeniedError(error: unknown): error is Error {
	return error instanceof Error && error.message.startsWith("sandbox: shell denied");
}

function buildSandboxDeniedBashResult(reason: string): BashResult {
	return { output: reason, exitCode: 1, cancelled: false, truncated: false };
}

export class SessionBashService {
	private abortController: AbortController | undefined;
	private pendingBashMessages: BashExecutionMessage[] = [];
	private readonly deps: SessionBashServiceDeps;

	constructor(deps: SessionBashServiceDeps) {
		this.deps = deps;
	}

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: ExecuteBashOptions,
	): Promise<BashResult> {
		const { settings, runtime, loadoutPolicy } = this.deps;
		const prefix = settings.getShellCommandPrefix();
		const shellPath = settings.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
		if (loadoutPolicy) {
			assertLoadoutAccess((request) => decideLoadoutAccess(loadoutPolicy, request), {
				operation: "execute",
				toolName: "bash",
				command: resolvedCommand,
			});
		}

		// Non-negotiable safety floor for headless callers (RPC bash): hard-deny
		// block-tier commands before any shell is spawned.
		if (options?.safetyGate === "headless") {
			const floorVerdict = classifyShellCommand(command);
			if (floorVerdict.risk === "block") {
				throw new Error(`OMK §0.1 safety floor blocked bash: [${floorVerdict.rule}] ${floorVerdict.reason}`);
			}
		}

		// Command-safety parity for non-interactive callers (RPC bash). Interactive
		// `!`/`!!` bash is gated earlier through the user_bash extension event, which
		// keeps its prompt-based approval semantics, so it does not pass safetyGate and
		// is never double-prompted here. confirm/block-tier verdicts deny headlessly;
		// the EFFECTIVE command (after the shell command prefix) is classified.
		if (options?.safetyGate === "headless") {
			const decision = await evaluateCommandGate(resolvedCommand, {
				hasUI: false,
				headlessConfirmPolicy: isCommandSafetyAssumeYesEnabled() ? "allow" : "deny",
			});
			if (decision?.deny) {
				const blocked = buildBlockedBashResult(decision.reason);
				this.recordBashResult(command, blocked, options);
				return blocked;
			}
		}

		this.abortController = new AbortController();

		try {
			try {
				const operations =
					options?.operations ??
					createLocalBashOperations({
						shellPath,
						sandboxPolicy: runtime.sandboxPreflight(options?.sandboxPolicy),
					});
				const cwd = this.deps.getCwd();
				const onChunkWrapped = (delta: string) => {
					onChunk?.(delta);
					this.deps.emit({ type: "bash_execution_update", id: options?.id, delta });
				};

				// Default-on verified path when a session ledger exists; OMK_VERIFIED_BASH=0 rolls back.
				const verified = await runtime.executeVerified({
					resolvedCommand,
					cwd,
					shellPath,
					operations,
					signal: this.abortController.signal,
					onChunk: onChunkWrapped,
				});
				const result: BashResult =
					verified ??
					(await executeBashWithOperations(resolvedCommand, cwd, operations, {
						onChunk: onChunkWrapped,
						signal: this.abortController.signal,
					}));

				this.recordBashResult(command, result, options);
				return result;
			} catch (error) {
				if (!isSandboxDeniedError(error)) {
					throw error;
				}
				const blocked = buildSandboxDeniedBashResult(error.message);
				this.recordBashResult(command, blocked, options);
				return blocked;
			}
		} finally {
			this.abortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.deps.isStreaming()) {
			this.pendingBashMessages.push(bashMessage);
		} else {
			this.deps.pushMessage(bashMessage);
			this.deps.appendMessage(bashMessage);
		}
	}

	/** Cancel running bash command. */
	abortBash(): void {
		this.abortController?.abort();
	}

	get isBashRunning(): boolean {
		return this.abortController !== undefined;
	}

	get hasPendingBashMessages(): boolean {
		return this.pendingBashMessages.length > 0;
	}

	/** Flush queued results after the agent turn completes (ordering contract). */
	flushPending(): void {
		if (this.pendingBashMessages.length === 0) return;
		for (const bashMessage of this.pendingBashMessages) {
			this.deps.pushMessage(bashMessage);
			this.deps.appendMessage(bashMessage);
		}
		this.pendingBashMessages = [];
	}
}
