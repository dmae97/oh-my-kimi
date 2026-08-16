import { createHash } from "node:crypto";
import { evaluateTask, PROTOCOL_VERSION, type TaskSpec } from "omk-protocol";
import { describe, expect, it } from "vitest";
import { createEvidenceReceipt, parseSha256Hex } from "../src/guardrails/evidence-receipt.ts";
import { computeWorkspaceManifestSha256 } from "../src/guardrails/workspace-fingerprint.ts";
import { evidenceReceiptToObservation } from "../src/index.ts";
import type { ArtifactState, EvidenceReceipt, WorkspaceFingerprint, WorkspaceScope } from "../src/types/evidence.ts";

function sha256(value: string): ReturnType<typeof parseSha256Hex> {
	return parseSha256Hex(createHash("sha256").update(value).digest("hex"));
}

function fingerprint(): WorkspaceFingerprint {
	const scope: WorkspaceScope = { root: "/workspace", artifactPaths: ["dist/result.txt"] };
	const artifacts: ArtifactState[] = [{ path: "dist/result.txt", state: "file", sha256: sha256("result"), size: 6 }];
	return {
		kind: "artifact-set",
		scope,
		artifacts,
		manifestSha256: computeWorkspaceManifestSha256(scope, artifacts),
	};
}

function receipt(status: "passed" | "failed" = "passed"): EvidenceReceipt {
	const fields = {
		receiptId: `receipt-${status}`,
		goalId: "task-1",
		claim: "focused verification",
		command: { kind: "argv", executable: "npm", argv: ["test"] },
		cwd: "/workspace",
		timeoutMs: 30_000,
		startedAt: "2026-08-16T00:01:00.000Z",
		finishedAt: "2026-08-16T00:01:01.000Z",
		durationMs: 1_000,
		workspaceBefore: fingerprint(),
		workspaceAfter: fingerprint(),
		alreadyRedactedOutput: {
			redactionPolicyId: "test-policy-v1",
			stdout: Buffer.from("redacted"),
			stderr: Buffer.alloc(0),
		},
		executor: "internal",
	} as const;
	return status === "passed"
		? createEvidenceReceipt({ ...fields, status: "passed", exitCode: 0 })
		: createEvidenceReceipt({ ...fields, status: "failed", exitCode: 1 });
}

const taskSpec: TaskSpec = {
	schemaVersion: PROTOCOL_VERSION,
	taskId: "task-1",
	goal: "Verify the focused test",
	createdAt: "2026-08-16T00:00:00.000Z",
	claims: [
		{
			claimId: "focused-test",
			statement: "The focused test passes",
			requirement: "required",
			condition: {
				kind: "observation",
				observationKind: "evidence_receipt.v3",
				scope: "attempt",
				facts: { exitCode: 0, timedOut: false, aborted: false },
			},
		},
	],
};

const attempt = {
	schemaVersion: PROTOCOL_VERSION,
	attemptId: "attempt-1",
	taskId: "task-1",
	sequence: 1,
	trigger: "initial" as const,
	startedAt: "2026-08-16T00:01:00.000Z",
	finishedAt: "2026-08-16T00:02:00.000Z",
	executor: { kind: "agent" },
	outcome: { kind: "completed" as const },
};

describe("evidenceReceiptToObservation", () => {
	it.each([
		["passed", "pass"],
		["failed", "fail"],
	] as const)("keeps receipt %s as facts and derives %s semantically", (status, verdict) => {
		const observation = evidenceReceiptToObservation(receipt(status), attempt.attemptId);
		const result = evaluateTask({
			evaluationId: `evaluation-${status}`,
			evaluatedAt: "2026-08-16T00:03:00.000Z",
			taskSpec,
			attempt,
			observations: [observation],
		});

		expect(Object.isFrozen(observation)).toBe(true);
		expect(Object.isFrozen(observation.facts)).toBe(true);
		expect(observation).toEqual(
			expect.objectContaining({
				taskId: "task-1",
				attemptId: "attempt-1",
				kind: "evidence_receipt.v3",
				facts: expect.objectContaining({
					claim: "focused verification",
					exitCode: status === "passed" ? 0 : 1,
					timedOut: false,
					aborted: false,
				}),
			}),
		);
		expect(observation.facts).not.toHaveProperty("status");
		expect(result.semanticVerdict).toBe(verdict);
	});

	it("rejects a receipt whose immutable core no longer matches its digest", () => {
		const valid = receipt();
		const tampered = { ...valid, core: { ...valid.core, claim: "tampered" } };

		expect(() => evidenceReceiptToObservation(tampered, attempt.attemptId)).toThrow(/core digest mismatch/);
	});
});
