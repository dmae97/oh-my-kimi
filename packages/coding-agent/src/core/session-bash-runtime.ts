/**
 * Session bash runtime: verified-evidence executor, default sandbox preflight,
 * and git-aware workspace scope in one cohesive, lazily-initialized unit.
 *
 * Extracted from AgentSession so the session class stays a coordinator; every
 * default-on behavior here keeps its opt-out:
 * - `OMK_VERIFIED_BASH=0` disables the receipt-bound executor.
 * - OS sandbox enforcement and network isolation are enabled by default.
 * - `OMK_BASH_SANDBOX=audit` keeps only the ledger preflight; `=0` disables it.
 */
import { join } from "node:path";
import { EvidenceReceiptStore } from "../guardrails/evidence-receipt-store.ts";
import type { ReplayLedgerManager } from "../guardrails/evidence-system.ts";
import { VerifiedEvidenceExecutor } from "../guardrails/verified-executor.ts";
import type { ReplayEventType } from "../types/evidence.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { getShellConfig, sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashResult } from "./bash-executor.ts";
import { detectSandboxBackend } from "./sandbox/backend.ts";
import { createWorkspaceSandboxPolicy, resolveBashSandboxMode } from "./sandbox/default-policy.ts";
import type { SandboxBackendStatus, SandboxMode } from "./sandbox/policy.ts";
import type { BashOperations, BashSandboxPreflight } from "./tools/bash.ts";
import { executeVerifiedBash } from "./verified-bash-adapter.ts";
import {
	isVerifiedBashEnabled,
	resolveSessionWorkspaceScope,
	resolveSessionWorkspaceScopeReport,
} from "./verified-bash-runtime.ts";

export interface SessionBashRuntimeOptions {
	readonly cwd: string;
	/** Actual execution cwd authority (session manager). */
	readonly getExecutionCwd: () => string;
	/** Session file anchor for the receipt store; undefined for ephemeral sessions. */
	readonly getSessionFile: () => string | undefined;
	readonly replayLedger: ReplayLedgerManager | undefined;
	readonly replayGoalId: string | undefined;
	readonly replayLaneId: string | undefined;
	readonly configuredSandboxPreflight: BashSandboxPreflight | undefined;
	readonly appendReplayEvent: (type: ReplayEventType, payload: unknown) => void;
}

export class SessionBashRuntime {
	private verifiedExecutor: VerifiedEvidenceExecutor | undefined;
	private detectedBackend: SandboxBackendStatus | undefined;
	private defaultSandboxPreflight: BashSandboxPreflight | null | undefined;
	private sandboxModeOverride: SandboxMode | undefined;
	private readonly options: SessionBashRuntimeOptions;

	constructor(options: SessionBashRuntimeOptions) {
		this.options = options;
	}

	/**
	 * Interactive promotion: switch the default sandbox mode at runtime
	 * (audit ↔ enforce ↔ off) without restarting the session. `undefined`
	 * restores env-based resolution.
	 */
	setSandboxMode(mode: SandboxMode | undefined): void {
		this.sandboxModeOverride = mode;
		this.defaultSandboxPreflight = undefined;
	}

	get sandboxMode(): SandboxMode {
		return this.sandboxModeOverride ?? resolveBashSandboxMode();
	}

	/** Lazy receipt executor bound to the session replay ledger (default-on path). */
	verifiedEvidenceExecutor(): VerifiedEvidenceExecutor | undefined {
		const { replayLedger, replayGoalId, getSessionFile, cwd } = this.options;
		if (!replayLedger || !replayGoalId || !isVerifiedBashEnabled()) return undefined;
		if (!this.verifiedExecutor) {
			const sessionFile = getSessionFile();
			const evidenceRoot = sessionFile
				? `${sessionFile}.evidence`
				: join(cwd, ".omk", "session-evidence", replayGoalId);
			this.verifiedExecutor = new VerifiedEvidenceExecutor({
				store: new EvidenceReceiptStore(join(evidenceRoot, "receipts")),
				ledger: replayLedger,
			});
		}
		return this.verifiedExecutor;
	}

	/** Configured preflight wins; otherwise use the default enforce preflight. */
	sandboxPreflight(override?: BashSandboxPreflight): BashSandboxPreflight | undefined {
		const preflight = override ?? this.options.configuredSandboxPreflight ?? this.getDefaultSandboxPreflight();
		if (!preflight || preflight.policy.mode === "off" || preflight.backend) {
			return preflight;
		}
		this.detectedBackend ??= detectSandboxBackend();
		return { ...preflight, backend: this.detectedBackend };
	}

	/**
	 * Default-on sandbox preflight. `enforce` wraps every local spawn with the
	 * OS backend and fails closed when none is available. Explicit `audit` keeps
	 * the spawn unwrapped but still reports decisions to the replay ledger.
	 */
	private getDefaultSandboxPreflight(): BashSandboxPreflight | undefined {
		if (this.defaultSandboxPreflight !== undefined) {
			return this.defaultSandboxPreflight ?? undefined;
		}
		const mode = this.sandboxMode;
		if (mode === "off") {
			this.defaultSandboxPreflight = null;
			return undefined;
		}
		this.detectedBackend ??= detectSandboxBackend();
		const detected = this.detectedBackend;
		const backend: SandboxBackendStatus =
			mode === "enforce"
				? detected
				: { platform: detected.platform, backendAvailable: false, domainAllowlistAvailable: false };
		// Root must cover the actual execution cwd (session manager), not just the
		// session workspace: in-memory or RPC sessions can legitimately differ.
		const policy = createWorkspaceSandboxPolicy(this.options.getExecutionCwd() || this.options.cwd, mode);
		this.defaultSandboxPreflight = {
			policy,
			backend,
			onSpawnDecision: (decision) => {
				if (decision.rule === "sandbox.off") return;
				this.options.appendReplayEvent("sandbox_audit", {
					mode,
					rule: decision.rule,
					reason: decision.reason,
					wrapped: "wrapped" in decision ? decision.wrapped : false,
					backendAvailable: backend.backendAvailable,
					platform: backend.platform,
				});
			},
		};
		return this.defaultSandboxPreflight;
	}

	/** Git-aware workspace scope for verified bash receipts (TTL-cached). */
	workspaceScope() {
		return resolveSessionWorkspaceScope(this.options.cwd);
	}

	/**
	 * The same scope plus what it could not bind. A receipt captured from a
	 * `partial_truncated` or `partial_excluded` scope proves only its selected
	 * paths, so a caller that presents a receipt as workspace-wide evidence must
	 * read this first.
	 */
	workspaceScopeReport() {
		return resolveSessionWorkspaceScopeReport(this.options.cwd);
	}

	get goalId(): string | undefined {
		return this.options.replayGoalId;
	}

	get laneId(): string | undefined {
		return this.options.replayLaneId;
	}

	/**
	 * Receipt-bound bash execution. Returns `undefined` when the verified path
	 * is unavailable (no ledger / opted out) so the caller falls back to the
	 * legacy executor. Streams sanitized text through `onChunk` while the
	 * adapter owns the raw receipt bytes.
	 */
	async executeVerified(request: {
		resolvedCommand: string;
		cwd: string;
		shellPath: string | undefined;
		operations: BashOperations;
		signal: AbortSignal;
		onChunk: (delta: string) => void;
	}): Promise<BashResult | undefined> {
		const evidenceExecutor = this.verifiedEvidenceExecutor();
		const goalId = this.options.replayGoalId;
		if (!evidenceExecutor || !goalId) return undefined;
		const { shell } = getShellConfig(request.shellPath);
		const command = request.resolvedCommand;
		const claim = command.length > 200 ? `bash: ${command.slice(0, 197)}...` : `bash: ${command}`;
		const outputChunks: string[] = [];
		const decoder = new TextDecoder();
		const execution = await executeVerifiedBash({
			evidenceExecutor,
			operations: request.operations,
			goalId,
			...(this.options.replayLaneId !== undefined ? { laneId: this.options.replayLaneId } : {}),
			claim,
			shell,
			script: command,
			cwd: request.cwd,
			timeoutMs: null,
			workspaceScope: this.workspaceScope(),
			executor: "bash-tool",
			signal: request.signal,
			onData: (data) => {
				const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");
				if (!text) return;
				outputChunks.push(text);
				request.onChunk(text);
			},
		});
		const status = execution.receipt.core.status;
		// Preserve pre-adapter timeout throw semantics after the receipt is bound.
		if (status === "timeout") {
			throw new Error("timeout:0");
		}
		const cancelled = status === "aborted" || request.signal.aborted;
		return {
			output: outputChunks.join(""),
			exitCode: cancelled ? undefined : (execution.receipt.core.exitCode ?? undefined),
			cancelled,
			truncated: false,
		};
	}
}
