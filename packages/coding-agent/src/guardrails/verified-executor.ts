import { randomUUID } from "node:crypto";
import type {
	EvidenceCommandDescriptor,
	EvidenceExecutor,
	EvidenceReceipt,
	EvidenceReceiptDisposition,
	ReplayEvent,
	Sha256Hex,
	WorkspaceScope,
} from "../types/evidence.ts";
import { redactCommandDescriptor } from "./command-redaction.ts";
import { type CommandHmacBinder, createCommandHmacBinder } from "./evidence-attestation.ts";
import type { AlreadyRedactedOutputBytes } from "./evidence-receipt.ts";
import {
	computeEvidenceCommandSha256,
	createEvidenceReceipt,
	evidenceReceiptReplayPayload,
	isSafeEvidenceReceiptId,
	parseSha256Hex,
	withEvidenceReceiptEnvelope,
} from "./evidence-receipt.ts";
import type { EvidenceReceiptStore } from "./evidence-receipt-store.ts";
import type { EvidenceGateOptions, ReplayLedgerManager } from "./evidence-system.ts";
import { latestRelevantWorkspaceMutationSeq } from "./evidence-system.ts";
import { captureWorkspaceFingerprint } from "./workspace-fingerprint.ts";

export type VerifiedEvidenceExecutionOutcome = EvidenceReceiptDisposition & {
	readonly alreadyRedactedOutput: AlreadyRedactedOutputBytes;
};

export interface VerifiedEvidenceExecutionRequest {
	readonly goalId: string;
	readonly laneId?: string;
	readonly claim: string;
	readonly command: EvidenceCommandDescriptor;
	readonly cwd: string;
	readonly timeoutMs: number | null;
	readonly workspaceScope: WorkspaceScope;
	readonly executor: EvidenceExecutor;
	readonly toolCallId?: string;
	readonly execute: () => Promise<VerifiedEvidenceExecutionOutcome>;
}

export interface VerifiedEvidenceMetadata {
	readonly receiptId: string;
	readonly receiptSchemaVersion: 3;
	readonly receiptCommandSha256: Sha256Hex;
	readonly receiptLaneId?: string;
	readonly timestamp: string;
}

export interface VerifiedEvidenceExecutionResult {
	readonly receipt: EvidenceReceipt;
	readonly receiptPath: string;
	readonly evidenceMetadata: VerifiedEvidenceMetadata;
}

export interface VerifiedEvidenceExecutorOptions {
	readonly store: EvidenceReceiptStore;
	readonly ledger: ReplayLedgerManager;
	readonly now?: () => Date;
	readonly receiptIdFactory?: () => string;
	readonly commandAttestationBinder?: CommandHmacBinder;
}

export class VerifiedEvidenceExecutorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerifiedEvidenceExecutorError";
	}
}

const EVIDENCE_EXECUTORS: ReadonlySet<string> = new Set(["bash-tool", "ci-runner", "mcp", "internal"]);

/**
 * Fail-closed parse of the callback-reported disposition. Only these two facts
 * (plus the redacted output bytes) are accepted from the callback; a contradictory
 * pair is rejected rather than repaired.
 */
function parseExecutionDisposition(status: unknown, exitCode: unknown): EvidenceReceiptDisposition {
	if (status === "passed" && exitCode === 0) return { status: "passed", exitCode: 0 };
	if (status === "failed" && Number.isSafeInteger(exitCode) && exitCode !== 0) {
		return { status: "failed", exitCode: exitCode as number };
	}
	if ((status === "timeout" || status === "aborted") && exitCode === null) {
		return { status, exitCode: null };
	}
	throw new VerifiedEvidenceExecutorError("execution callback returned an invalid disposition");
}

function assertRequestText(value: unknown, label: string): void {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new VerifiedEvidenceExecutorError(`${label} must be a non-empty string without NUL bytes`);
	}
}

function validateRequest(request: VerifiedEvidenceExecutionRequest): void {
	assertRequestText(request.goalId, "goalId");
	if (request.laneId !== undefined) assertRequestText(request.laneId, "laneId");
	assertRequestText(request.claim, "claim");
	assertRequestText(request.cwd, "cwd");
	if (request.toolCallId !== undefined) assertRequestText(request.toolCallId, "toolCallId");
	if (request.timeoutMs !== null && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
		throw new VerifiedEvidenceExecutorError("timeoutMs must be null or a positive safe integer");
	}
	if (!EVIDENCE_EXECUTORS.has(request.executor)) {
		throw new VerifiedEvidenceExecutorError("executor is invalid");
	}
	if (typeof request.execute !== "function") {
		throw new VerifiedEvidenceExecutorError("execute must be a function");
	}
}

/**
 * Execute one caller-provided verification operation between two scoped workspace snapshots,
 * then persist a replay-bound immutable receipt. The callback must normalize process
 * completion and provide already-redacted bounded output bytes.
 */
export class VerifiedEvidenceExecutor {
	private readonly store: EvidenceReceiptStore;
	private readonly ledger: ReplayLedgerManager;
	private readonly now: () => Date;
	private readonly receiptIdFactory: () => string;
	private readonly commandAttestationBinder: CommandHmacBinder;
	private readonly attestedCommands = new Map<string, EvidenceCommandDescriptor>();

	constructor(options: VerifiedEvidenceExecutorOptions) {
		this.store = options.store;
		this.ledger = options.ledger;
		this.now = options.now ?? (() => new Date());
		this.receiptIdFactory = options.receiptIdFactory ?? randomUUID;
		this.commandAttestationBinder = options.commandAttestationBinder ?? createCommandHmacBinder();
	}

	readonly resolveReceipt = (receiptId: string): EvidenceReceipt => this.store.read(receiptId);

	readonly resolveLedgerEvent = (seq: number): ReplayEvent | undefined =>
		this.ledger.getEvents().find((event) => event.seq === seq);

	readonly resolveVerifiedLedgerSnapshot = () => this.ledger.getVerifiedSnapshot();

	readonly resolveAttestedCommand = (receiptId: string): EvidenceCommandDescriptor | undefined => {
		const command = this.attestedCommands.get(receiptId);
		return command === undefined ? undefined : structuredClone(command);
	};

	/** Latest relevant `workspace_mutation` seq from this executor's own replay ledger. */
	readonly resolveLatestWorkspaceMutationSeq = (scope: WorkspaceScope): number | null =>
		latestRelevantWorkspaceMutationSeq(this.ledger.getEvents(), scope);

	createGateOptions(): Pick<
		EvidenceGateOptions,
		| "resolveReceipt"
		| "resolveLedgerEvent"
		| "resolveVerifiedLedgerSnapshot"
		| "captureWorkspaceFingerprint"
		| "resolveLatestWorkspaceMutationSeq"
		| "commandAttestationBinder"
		| "resolveAttestedCommand"
	> {
		return {
			resolveReceipt: this.resolveReceipt,
			resolveLedgerEvent: this.resolveLedgerEvent,
			resolveVerifiedLedgerSnapshot: this.resolveVerifiedLedgerSnapshot,
			captureWorkspaceFingerprint,
			resolveLatestWorkspaceMutationSeq: this.resolveLatestWorkspaceMutationSeq,
			commandAttestationBinder: this.commandAttestationBinder,
			resolveAttestedCommand: this.resolveAttestedCommand,
		};
	}

	async execute(request: VerifiedEvidenceExecutionRequest): Promise<VerifiedEvidenceExecutionResult> {
		validateRequest(request);
		const ledgerGoalId = this.ledger.getLedger().goalId;
		if (request.goalId !== ledgerGoalId) {
			throw new VerifiedEvidenceExecutorError("verification goalId does not match the replay ledger");
		}
		const receiptId = this.receiptIdFactory();
		if (!isSafeEvidenceReceiptId(receiptId)) {
			throw new VerifiedEvidenceExecutorError("receiptIdFactory returned an unsafe receipt ID");
		}
		// Tokenize the persisted representation and bind the ORIGINAL command under the
		// internal process key BEFORE any side effect; unrepresentable or oversize
		// redaction metadata fails closed here. The original is never persisted.
		const redaction = redactCommandDescriptor(request.command);
		const commandBinding = this.commandAttestationBinder.bind(request.command);
		const receiptCommandSha256 = computeEvidenceCommandSha256(redaction.command);
		const workspaceBefore = captureWorkspaceFingerprint(request.workspaceScope);
		const started = this.now();
		const startedMs = started.getTime();
		if (!Number.isSafeInteger(startedMs)) {
			throw new VerifiedEvidenceExecutorError("verification clock produced an invalid start time");
		}
		const outcome = await request.execute();
		// Independent-review P3: accept ONLY the disposition and the already-redacted
		// output bytes from the callback. Every other receipt field is executor-captured
		// provenance that a callback outcome object must never be able to override.
		const { status, exitCode, alreadyRedactedOutput } = outcome;
		const disposition = parseExecutionDisposition(status, exitCode);
		const finished = this.now();
		const finishedMs = finished.getTime();
		if (!Number.isSafeInteger(finishedMs) || finishedMs < startedMs) {
			throw new VerifiedEvidenceExecutorError("verification clock produced an invalid execution interval");
		}
		const workspaceAfter = captureWorkspaceFingerprint(request.workspaceScope);
		const receipt = createEvidenceReceipt({
			receiptId,
			goalId: request.goalId,
			...(request.laneId !== undefined ? { laneId: request.laneId } : {}),
			claim: request.claim,
			command: redaction.command,
			commandRedaction: redaction.summary,
			commandBinding,
			cwd: request.cwd,
			timeoutMs: request.timeoutMs,
			startedAt: started.toISOString(),
			finishedAt: finished.toISOString(),
			durationMs: finishedMs - startedMs,
			workspaceBefore,
			workspaceAfter,
			executor: request.executor,
			...disposition,
			alreadyRedactedOutput,
			...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
		});
		const event = this.ledger.append({
			type: "evidence_receipt",
			goalId: request.goalId,
			...(request.laneId !== undefined ? { laneId: request.laneId } : {}),
			payload: evidenceReceiptReplayPayload(receipt),
		});
		this.ledger.persist();
		const boundReceipt = withEvidenceReceiptEnvelope(receipt, {
			ledgerBinding: { seq: event.seq, eventHash: parseSha256Hex(event.eventHash, "ledger eventHash") },
		});
		const receiptPath = this.store.write(boundReceipt);
		this.attestedCommands.set(receiptId, structuredClone(request.command));
		return {
			receipt: boundReceipt,
			receiptPath,
			evidenceMetadata: {
				receiptId,
				receiptSchemaVersion: 3,
				receiptCommandSha256,
				...(request.laneId !== undefined ? { receiptLaneId: request.laneId } : {}),
				timestamp: finished.toISOString(),
			},
		};
	}
}
