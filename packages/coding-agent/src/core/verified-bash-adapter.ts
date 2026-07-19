import { MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES } from "../guardrails/evidence-receipt.ts";
import type {
	VerifiedEvidenceExecutionOutcome,
	VerifiedEvidenceExecutionResult,
	VerifiedEvidenceExecutor,
} from "../guardrails/verified-executor.ts";
import type { WorkspaceScope } from "../types/evidence.ts";
import { getShellConfig } from "../utils/shell.ts";
import { redactSensitiveText } from "./redaction.ts";
import { type BashOperations, type BashSandboxPreflight, createLocalBashOperations } from "./tools/bash.ts";

export const VERIFIED_BASH_REDACTION_POLICY_ID =
	"omk-bash-combined-v1+omk-sensitive-text-v1+capture-tail-128k+tail-64k" as const;

const MAX_CAPTURE_BYTES = MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES * 2;

export interface VerifiedBashExecutionRequest {
	readonly evidenceExecutor: VerifiedEvidenceExecutor;
	readonly operations: BashOperations;
	readonly goalId: string;
	readonly laneId?: string;
	readonly claim: string;
	readonly shell: string;
	readonly script: string;
	readonly cwd: string;
	readonly timeoutMs: number | null;
	readonly workspaceScope: WorkspaceScope;
	readonly executor?: "bash-tool" | "ci-runner";
	readonly toolCallId?: string;
	readonly signal?: AbortSignal;
}

export type VerifiedLocalBashExecutionRequest = Omit<VerifiedBashExecutionRequest, "operations" | "shell"> & {
	readonly shellPath?: string;
	readonly sandboxPolicy?: BashSandboxPreflight;
};

export class VerifiedBashAdapterError extends Error {
	readonly code = "INVALID_RUNNER_EXIT" as const;

	constructor(message: string) {
		super(message);
		this.name = "VerifiedBashAdapterError";
	}
}

/**
 * Bind an opt-in, caller-trusted BashOperations execution to a receipt.
 * BashOperations exposes a combined output stream, so the policy records the
 * redacted bounded stream as stdout and leaves stderr empty by construction.
 */
export async function executeVerifiedBash(
	request: VerifiedBashExecutionRequest,
): Promise<VerifiedEvidenceExecutionResult> {
	let combined = Buffer.alloc(0);

	const capture = (data: Buffer): void => {
		// ponytail: bounded concat is simpler than a chunk deque; split if profiling shows pressure.
		const appended = Buffer.concat([combined, data]);
		combined = appended.byteLength > MAX_CAPTURE_BYTES ? appended.subarray(-MAX_CAPTURE_BYTES) : appended;
	};

	const alreadyRedactedOutput = () => {
		const redacted = Buffer.from(redactSensitiveText(combined.toString("utf8")));
		const bounded =
			redacted.byteLength > MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES
				? redacted.subarray(-MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES)
				: redacted;
		return {
			redactionPolicyId: VERIFIED_BASH_REDACTION_POLICY_ID,
			stdout: bounded,
			stderr: Buffer.alloc(0),
		};
	};

	return request.evidenceExecutor.execute({
		goalId: request.goalId,
		...(request.laneId !== undefined ? { laneId: request.laneId } : {}),
		claim: request.claim,
		command: { kind: "shell", shell: request.shell, script: request.script },
		cwd: request.cwd,
		timeoutMs: request.timeoutMs,
		workspaceScope: request.workspaceScope,
		executor: request.executor ?? "bash-tool",
		...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
		execute: async (): Promise<VerifiedEvidenceExecutionOutcome> => {
			if (request.signal?.aborted) {
				return { status: "aborted", exitCode: null, alreadyRedactedOutput: alreadyRedactedOutput() };
			}
			try {
				const result = await request.operations.exec(request.script, request.cwd, {
					onData: capture,
					...(request.signal !== undefined ? { signal: request.signal } : {}),
					...(request.timeoutMs !== null ? { timeout: request.timeoutMs / 1000 } : {}),
				});
				if (request.signal?.aborted) {
					return { status: "aborted", exitCode: null, alreadyRedactedOutput: alreadyRedactedOutput() };
				}
				if (result.exitCode === null || !Number.isSafeInteger(result.exitCode)) {
					throw new VerifiedBashAdapterError(
						"bash runner returned an invalid exit code without an abort or timeout signal",
					);
				}
				return result.exitCode === 0
					? { status: "passed", exitCode: 0, alreadyRedactedOutput: alreadyRedactedOutput() }
					: { status: "failed", exitCode: result.exitCode, alreadyRedactedOutput: alreadyRedactedOutput() };
			} catch (error) {
				if (request.signal?.aborted || (error instanceof Error && error.message === "aborted")) {
					return { status: "aborted", exitCode: null, alreadyRedactedOutput: alreadyRedactedOutput() };
				}
				if (error instanceof Error && error.message.startsWith("timeout:")) {
					return { status: "timeout", exitCode: null, alreadyRedactedOutput: alreadyRedactedOutput() };
				}
				throw error;
			}
		},
	});
}

/** Bind OMK's first-party local shell backend to the verified bash adapter. */
export async function executeVerifiedLocalBash(
	request: VerifiedLocalBashExecutionRequest,
): Promise<VerifiedEvidenceExecutionResult> {
	const { shellPath, sandboxPolicy, ...executionRequest } = request;
	const { shell } = getShellConfig(shellPath);
	const resolvedShellPath = shell === "sh" && shellPath === undefined ? undefined : shell;
	const operations = createLocalBashOperations({
		...(resolvedShellPath !== undefined ? { shellPath: resolvedShellPath } : {}),
		...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
	});
	return executeVerifiedBash({ ...executionRequest, operations, shell });
}
