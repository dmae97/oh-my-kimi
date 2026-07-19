import { join } from "node:path";
import { executeVerifiedLocalBash } from "../core/verified-bash-adapter.ts";
import { EvidenceReceiptStore } from "../guardrails/evidence-receipt-store.ts";
import {
	EvidenceGate,
	ReplayLedgerManager,
	TaskContractBuilder,
	VerifyReporterV2,
} from "../guardrails/evidence-system.ts";
import { VerifiedEvidenceExecutor } from "../guardrails/verified-executor.ts";
import type { EvidenceReceipt, EvidenceReceiptStatus, MergeGateResult, WorkspaceScope } from "../types/evidence.ts";

const PASSED_RECEIPT_STATUS = {
	passed: true,
	failed: false,
	timeout: false,
	aborted: false,
} as const satisfies Record<EvidenceReceiptStatus, boolean>;

export interface VerifiedCiCommandRequest {
	readonly evidenceDir: string;
	readonly goalId: string;
	readonly claim: string;
	readonly script: string;
	readonly cwd: string;
	readonly timeoutMs: number | null;
	readonly workspaceScope: WorkspaceScope;
	readonly shellPath?: string;
}

export interface VerifiedCiCommandResult {
	readonly exitCode: 0 | 1;
	readonly gate: MergeGateResult;
	readonly receipt: EvidenceReceipt;
	readonly receiptPath: string;
	readonly reportPath: string;
}

/** Execute one first-party CI verifier through the local receipt-bound bash path. */
export async function runVerifiedCiCommand(request: VerifiedCiCommandRequest): Promise<VerifiedCiCommandResult> {
	const executor = new VerifiedEvidenceExecutor({
		store: new EvidenceReceiptStore(join(request.evidenceDir, "receipts")),
		ledger: new ReplayLedgerManager(request.goalId, join(request.evidenceDir, "ledger", "events.jsonl")),
	});
	const execution = await executeVerifiedLocalBash({
		evidenceExecutor: executor,
		goalId: request.goalId,
		laneId: "ci-runner",
		claim: request.claim,
		script: request.script,
		cwd: request.cwd,
		timeoutMs: request.timeoutMs,
		workspaceScope: request.workspaceScope,
		executor: "ci-runner",
		...(request.shellPath !== undefined ? { shellPath: request.shellPath } : {}),
	});
	const passed = PASSED_RECEIPT_STATUS[execution.receipt.core.status];
	// Persist only the receipt's redacted command representation; the original
	// script may carry inline secrets and must never reach contract or report.
	const persistedCommand = execution.receipt.core.command;
	const verificationCommand =
		persistedCommand.kind === "shell"
			? persistedCommand.script
			: [persistedCommand.executable, ...persistedCommand.argv].join(" ");
	const contract = new TaskContractBuilder(request.goalId)
		.setClaim(request.claim)
		.addRequiredEvidence({
			claim: request.claim,
			category: "release",
			verificationCommand,
			receiptId: execution.evidenceMetadata.receiptId,
			receiptSchemaVersion: 3,
			receiptCommandSha256: execution.evidenceMetadata.receiptCommandSha256,
			...(execution.evidenceMetadata.receiptLaneId !== undefined
				? { receiptLaneId: execution.evidenceMetadata.receiptLaneId }
				: {}),
		})
		.updateEvidenceStatus(request.claim, passed ? "satisfied" : "failed")
		.setFinalRisk(
			"Receipt freshness covers the selected workspace scope (git dirty state or artifact set) plus ledger-sequenced workspace mutations.",
		)
		.setVerdict(passed ? "pass" : "fail")
		.build();
	// The gate options wire recapture and the workspace-mutation freshness source to
	// this command's own ReplayLedger, so a mutation recorded after the receipt blocks.
	const gate = new EvidenceGate({ receiptMode: "strict", ...executor.createGateOptions() }).check(contract);
	const reportPath = new VerifyReporterV2({ outputDir: request.evidenceDir, goalId: request.goalId }).write(
		contract,
		gate,
	);
	return {
		exitCode: gate.status === "open" ? 0 : 1,
		gate,
		receipt: execution.receipt,
		receiptPath: execution.receiptPath,
		reportPath,
	};
}
