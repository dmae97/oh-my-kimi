import { type ApprovalReceipt, computeApprovalContentDigest, validateApprovalReceipt } from "./approval-receipt.ts";

export type ApprovalVerificationFailure =
	| "invalid-receipt"
	| "not-approved"
	| "session-mismatch"
	| "plan-path-mismatch"
	| "plan-content-mismatch";

export type ApprovalVerificationResult =
	| { valid: true; receipt: ApprovalReceipt }
	| { valid: false; reason: ApprovalVerificationFailure };

export interface ApprovalExecutionBinding {
	sessionId: string;
	planPath: string;
	planContent: string;
}

/** Verify immediately before execution; a persisted approval never authorizes changed plan bytes. */
export function verifyApprovalForExecution(
	value: unknown,
	binding: ApprovalExecutionBinding,
): ApprovalVerificationResult {
	let receipt: ApprovalReceipt;
	try {
		receipt = validateApprovalReceipt(value);
	} catch {
		return { valid: false, reason: "invalid-receipt" };
	}
	if (receipt.core.decision !== "approved") return { valid: false, reason: "not-approved" };
	if (receipt.core.sessionId !== binding.sessionId) return { valid: false, reason: "session-mismatch" };
	if (receipt.core.plan.path !== binding.planPath) return { valid: false, reason: "plan-path-mismatch" };
	const digest = computeApprovalContentDigest(binding.planContent);
	if (receipt.core.plan.sha256 !== digest.sha256 || receipt.core.plan.bytes !== digest.bytes) {
		return { valid: false, reason: "plan-content-mismatch" };
	}
	return { valid: true, receipt };
}
