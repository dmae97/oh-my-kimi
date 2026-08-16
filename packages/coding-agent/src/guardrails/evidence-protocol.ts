import { type Observation, PROTOCOL_VERSION } from "omk-protocol";
import type { EvidenceReceipt } from "../types/evidence.ts";
import { validateEvidenceReceipt } from "./evidence-receipt.ts";

/**
 * Projects an integrity-checked EvidenceReceipt v3 into immutable protocol facts.
 *
 * This verifies the receipt core digest. Ledger membership and trusted attestation
 * remain separate integrity checks and are not implied by this adapter.
 */
export function evidenceReceiptToObservation(receipt: EvidenceReceipt, attemptId: string): Observation {
	if (attemptId.trim().length === 0) throw new Error("attemptId must be a non-empty string");
	const validated = validateEvidenceReceipt(receipt);
	const { core, envelope } = validated;
	return Object.freeze({
		schemaVersion: PROTOCOL_VERSION,
		observationId: `evidence-receipt:${core.receiptId}`,
		taskId: core.goalId,
		attemptId,
		observedAt: core.finishedAt,
		kind: "evidence_receipt.v3",
		source: Object.freeze({ kind: "evidence_receipt", id: core.receiptId }),
		facts: Object.freeze({
			receiptSchemaVersion: core.schemaVersion,
			claim: core.claim,
			exitCode: core.exitCode,
			timedOut: core.status === "timeout",
			aborted: core.status === "aborted",
			durationMs: core.durationMs,
			executor: core.executor,
		}),
		evidenceRefs: Object.freeze([`evidence-receipt:${core.receiptId}#sha256:${envelope.coreSha256}`]),
	});
}
