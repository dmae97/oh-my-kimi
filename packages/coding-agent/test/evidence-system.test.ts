import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCommandHmacBinder } from "../src/guardrails/evidence-attestation.ts";
import {
	type CreateEvidenceReceiptInput,
	computeEvidenceCommandSha256,
	createEvidenceReceipt,
	evidenceReceiptReplayPayload,
	parseSha256Hex,
	withEvidenceReceiptEnvelope,
} from "../src/guardrails/evidence-receipt.ts";
import {
	EvidenceGate,
	FailClosedMergeGate,
	ReplayLedgerManager,
	TaskContractBuilder,
	VerifyReporterV2,
} from "../src/guardrails/evidence-system.ts";
import { computeWorkspaceManifestSha256 } from "../src/guardrails/workspace-fingerprint.ts";
import type {
	ArtifactState,
	EvidenceItem,
	EvidenceReceiptStatus,
	MergeGateResult,
	TaskContract,
	WorkspaceFingerprint,
	WorkspaceScope,
} from "../src/types/evidence.ts";

function gateFingerprint(): WorkspaceFingerprint {
	const scope: WorkspaceScope = { root: "/workspace", artifactPaths: ["dist/result.txt"] };
	const contents = "verified";
	const artifacts: ArtifactState[] = [
		{
			path: "dist/result.txt",
			state: "file",
			sha256: parseSha256Hex(createHash("sha256").update(contents).digest("hex")),
			size: Buffer.byteLength(contents),
		},
	];
	return {
		kind: "artifact-set",
		scope,
		artifacts,
		manifestSha256: computeWorkspaceManifestSha256(scope, artifacts),
	};
}

const GATE_COMMAND = { kind: "argv" as const, executable: "git", argv: ["diff"] };
const GATE_BINDER = createCommandHmacBinder();

type GateReceiptOverrides = {
	receiptId?: string;
	goalId?: string;
	claim?: string;
	status?: EvidenceReceiptStatus;
	exitCode?: number | null;
};

function gateReceipt(overrides: GateReceiptOverrides = {}) {
	return createEvidenceReceipt({
		receiptId: "receipt-1",
		goalId: "g",
		claim: "File changed",
		command: GATE_COMMAND,
		commandRedaction: { policyId: "omk-command-redaction-v1", placeholders: [] },
		commandBinding: GATE_BINDER.bind(GATE_COMMAND),
		cwd: "/workspace",
		timeoutMs: 30_000,
		startedAt: "2026-07-17T00:00:00.000Z",
		finishedAt: "2026-07-17T00:00:01.000Z",
		durationMs: 1_000,
		status: "passed",
		exitCode: 0,
		workspaceBefore: gateFingerprint(),
		workspaceAfter: gateFingerprint(),
		alreadyRedactedOutput: {
			redactionPolicyId: "test-redaction-v1",
			stdout: Buffer.from("ok\n"),
			stderr: Buffer.from(""),
		},
		executor: "internal",
		...overrides,
	} as CreateEvidenceReceiptInput);
}

describe("TaskContractBuilder", () => {
	it("builds a basic contract", () => {
		const builder = new TaskContractBuilder("goal-1");
		const contract = builder
			.setClaim("Implement feature X")
			.addRequiredEvidence({
				claim: "File was changed",
				category: "feature",
				artifactPath: "src/x.ts",
				verificationCommand: "git diff --stat",
			})
			.setFinalRisk("Low risk")
			.setVerdict("pass")
			.build();

		expect(contract.goalId).toBe("goal-1");
		expect(contract.completionClaim).toBe("Implement feature X");
		expect(contract.requiredEvidence).toHaveLength(1);
		expect(contract.verdict).toBe("pass");
		expect(contract.createdAt).toBeDefined();
	});

	it("updates evidence status", () => {
		const builder = new TaskContractBuilder("goal-2");
		builder.addRequiredEvidence({
			claim: "Tests pass",
			category: "feature",
			verificationCommand: "npm test",
		});
		builder.updateEvidenceStatus("Tests pass", "satisfied");
		const contract = builder.build();
		expect(contract.requiredEvidence[0].status).toBe("satisfied");
	});

	it("round-trips JSON", () => {
		const builder = new TaskContractBuilder("goal-3");
		const original = builder.setClaim("Docs updated").setVerdict("pass").build();
		const json = TaskContractBuilder.toJSON(original);
		const parsed = TaskContractBuilder.fromJSON(json);
		expect(parsed.goalId).toBe(original.goalId);
		expect(parsed.completionClaim).toBe(original.completionClaim);
	});

	it("preserves receipt metadata when parsing contract JSON", () => {
		const contract: TaskContract = {
			goalId: "g",
			completionClaim: "c",
			requiredEvidence: [
				{
					claim: "receipt-backed",
					category: "feature",
					timestamp: "",
					status: "satisfied",
					receiptId: "receipt-1",
					receiptSchemaVersion: 3,
					receiptCommandSha256: parseSha256Hex("0".repeat(64)),
					receiptLaneId: "lane-1",
				},
			],
			finalRisk: "",
			verdict: "pass",
			createdAt: "",
			updatedAt: "",
		};

		expect(TaskContractBuilder.fromJSON(TaskContractBuilder.toJSON(contract)).requiredEvidence[0]).toMatchObject({
			receiptId: "receipt-1",
			receiptSchemaVersion: 3,
			receiptCommandSha256: "0".repeat(64),
			receiptLaneId: "lane-1",
		});
	});

	it("fails closed on malformed contract JSON", () => {
		expect(() => TaskContractBuilder.fromJSON("[]")).toThrow(/object/);
		expect(() => TaskContractBuilder.fromJSON(JSON.stringify({ goalId: "g" }))).toThrow(/mistyped/);
		const badVerdict = {
			goalId: "g",
			completionClaim: "c",
			finalRisk: "",
			verdict: "maybe",
			createdAt: "",
			updatedAt: "",
			requiredEvidence: [],
		};
		expect(() => TaskContractBuilder.fromJSON(JSON.stringify(badVerdict))).toThrow(/verdict/);
		const badEvidence = { ...badVerdict, verdict: "pass", requiredEvidence: [{ claim: 1 }] };
		expect(() => TaskContractBuilder.fromJSON(JSON.stringify(badEvidence))).toThrow(/evidence\[0\]/);
		const badStatus = {
			...badVerdict,
			verdict: "pass",
			requiredEvidence: [{ claim: "c", category: "feature", timestamp: "", status: "done" }],
		};
		expect(() => TaskContractBuilder.fromJSON(JSON.stringify(badStatus))).toThrow(/invalid status/);
	});

	it("build returns deep copies detached from the builder", () => {
		const builder = new TaskContractBuilder("goal-4");
		builder.addRequiredEvidence({ claim: "A", category: "feature" });
		const first = builder.build();
		first.requiredEvidence[0].status = "failed";
		expect(builder.build().requiredEvidence[0].status).toBe("pending");
	});
});

describe("EvidenceGate", () => {
	function makeContract(evidence: EvidenceItem[]): TaskContract {
		return {
			goalId: "g",
			completionClaim: "c",
			requiredEvidence: evidence,
			finalRisk: "",
			verdict: "pass",
			createdAt: "",
			updatedAt: "",
		};
	}

	it("passes when all conditions met", () => {
		const contract = makeContract([
			{
				claim: "File changed",
				category: "feature",
				artifactPath: "src/x.ts",
				verificationCommand: "git diff",
				hash: "abc123",
				status: "satisfied",
				timestamp: "",
			},
		]);
		const gate = new EvidenceGate({ receiptMode: "legacy" });
		const result = gate.check(contract);
		expect(result.status).toBe("open");
	});

	it("blocks when no evidence satisfied", () => {
		const contract = makeContract([
			{
				claim: "File changed",
				category: "feature",
				status: "pending",
				timestamp: "",
			},
		]);
		const gate = new EvidenceGate();
		const result = gate.check(contract);
		expect(result.status).toBe("conditional");
	});

	it("blocks when evidence lacks hash", () => {
		const contract = makeContract([
			{
				claim: "File changed",
				category: "feature",
				artifactPath: "src/x.ts",
				verificationCommand: "git diff",
				status: "satisfied",
				timestamp: "",
			},
		]);
		const gate = new EvidenceGate({ receiptMode: "legacy" });
		const result = gate.check(contract);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("SHA-256 hash");
	});

	it("conditional when pending evidence exists", () => {
		const contract = makeContract([
			{
				claim: "A",
				category: "feature",
				artifactPath: "a.ts",
				verificationCommand: "cmd",
				hash: "h1",
				status: "satisfied",
				timestamp: "",
			},
			{
				claim: "B",
				category: "feature",
				status: "pending",
				timestamp: "",
			},
		]);
		const gate = new EvidenceGate({ minEvidenceCount: 2 });
		const result = gate.check(contract);
		expect(result.status).toBe("conditional");
	});

	function receiptBackedContract(): TaskContract {
		return makeContract([
			{
				claim: "File changed",
				category: "feature",
				artifactPath: "dist/result.txt",
				verificationCommand: "git diff",
				hash: "legacy-hash",
				status: "satisfied",
				timestamp: "",
				receiptId: "receipt-1",
				receiptSchemaVersion: 3,
			},
		]);
	}

	it("blocks metadata-only evidence in strict mode", () => {
		const contract = receiptBackedContract();
		contract.requiredEvidence[0].receiptId = undefined;
		const result = new EvidenceGate({ receiptMode: "strict" }).check(contract);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("receipt");
	});

	it("requires receipt schema version 3 only for the strict receipt gate", () => {
		const contract = receiptBackedContract();
		delete contract.requiredEvidence[0].receiptSchemaVersion;

		const strict = new EvidenceGate({ receiptMode: "strict" }).check(contract);
		expect(strict.status).toBe("blocked");
		expect(strict.reason).toContain("schema");
		expect(new EvidenceGate({ receiptMode: "prefer" }).check(contract).status).toBe("conditional");
		expect(new EvidenceGate({ receiptMode: "legacy" }).check(contract).status).toBe("open");
	});

	it("returns conditional for metadata-only evidence in prefer mode", () => {
		const contract = receiptBackedContract();
		contract.requiredEvidence[0].receiptId = undefined;
		const result = new EvidenceGate({ receiptMode: "prefer" }).check(contract);
		expect(result.status).toBe("conditional");
		expect(result.reason).toContain("receipt");
	});

	it("allows legacy metadata only when legacy mode is explicit", () => {
		const contract = receiptBackedContract();
		contract.requiredEvidence[0].receiptId = undefined;
		expect(new EvidenceGate({ receiptMode: "legacy" }).check(contract).status).toBe("open");
		expect(new EvidenceGate().check(contract).status).toBe("conditional");
	});

	it("opens strict mode for a valid matching passed receipt", () => {
		const path = "/tmp/omk-evidence-gate-system.jsonl";
		for (const suffix of ["", ".head", ".lock"]) rmSync(`${path}${suffix}`, { recursive: true, force: true });
		const initialReceipt = gateReceipt();
		const ledger = new ReplayLedgerManager("g", path);
		const event = ledger.append({
			type: "evidence_receipt",
			goalId: "g",
			payload: evidenceReceiptReplayPayload(initialReceipt),
		});
		const receipt = withEvidenceReceiptEnvelope(initialReceipt, {
			ledgerBinding: { seq: event.seq, eventHash: parseSha256Hex(event.eventHash) },
		});
		const contract = receiptBackedContract();
		contract.requiredEvidence[0].receiptCommandSha256 = computeEvidenceCommandSha256(receipt.core.command);
		const result = new EvidenceGate({
			receiptMode: "strict",
			resolveReceipt: () => receipt,
			resolveVerifiedLedgerSnapshot: () => ledger.getVerifiedSnapshot(),
			captureWorkspaceFingerprint: () => receipt.core.workspaceAfter,
			commandAttestationBinder: GATE_BINDER,
			resolveAttestedCommand: () => GATE_COMMAND,
		}).check(contract);
		expect(result.status).toBe("open");
	});

	it("blocks a failed non-zero receipt in strict mode", () => {
		const receipt = gateReceipt({ status: "failed", exitCode: 1 });
		const result = new EvidenceGate({ receiptMode: "strict", resolveReceipt: () => receipt }).check(
			receiptBackedContract(),
		);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("pass with exit code 0");
	});

	it.each([
		["goal mismatch", gateReceipt({ goalId: "other-goal" }), "goal"],
		["claim mismatch", gateReceipt({ claim: "Other claim" }), "claim"],
	])("blocks %s receipts in strict mode", (_name, receipt, expectedReason) => {
		const result = new EvidenceGate({ receiptMode: "strict", resolveReceipt: () => receipt }).check(
			receiptBackedContract(),
		);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain(expectedReason);
	});

	it("blocks a tampered receipt in strict mode", () => {
		const receipt = gateReceipt();
		const tampered = { ...receipt, core: { ...receipt.core, claim: "tampered" } };
		const result = new EvidenceGate({ receiptMode: "strict", resolveReceipt: () => tampered }).check(
			receiptBackedContract(),
		);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("invalid");
	});
});

describe("FailClosedMergeGate", () => {
	function makeContract(evidence: EvidenceItem[]): TaskContract {
		return {
			goalId: "g",
			completionClaim: "c",
			requiredEvidence: evidence,
			finalRisk: "",
			verdict: "pass",
			createdAt: "",
			updatedAt: "",
		};
	}

	it("passes when all evidence gates pass", () => {
		const contract = makeContract([
			{
				claim: "File changed",
				category: "feature",
				artifactPath: "src/x.ts",
				verificationCommand: "git diff",
				hash: "abc123",
				status: "satisfied",
				timestamp: "",
			},
		]);
		const mergeGate = new FailClosedMergeGate([new EvidenceGate({ receiptMode: "legacy" })]);
		const result = mergeGate.check(contract);
		expect(result.status).toBe("open");
	});

	it("blocks when evidence is missing", () => {
		const contract = makeContract([
			{
				claim: "File changed",
				category: "feature",
				status: "pending",
				timestamp: "",
			},
		]);
		const mergeGate = new FailClosedMergeGate();
		const result = mergeGate.check(contract);
		expect(result.status).toBe("conditional");
		expect(result.reason).toContain("Conditional pass");
	});

	it("blocks when contract verdict is fail", () => {
		const contract = makeContract([
			{
				claim: "File changed",
				category: "feature",
				artifactPath: "src/x.ts",
				verificationCommand: "git diff",
				hash: "abc123",
				status: "satisfied",
				timestamp: "",
			},
		]);
		contract.verdict = "fail";
		const mergeGate = new FailClosedMergeGate();
		const result = mergeGate.check(contract);
		expect(result.status).toBe("blocked");
	});
});

describe("VerifyReporterV2", () => {
	it("renders markdown report", () => {
		const reporter = new VerifyReporterV2({ outputDir: "/tmp/omk-verify", goalId: "g1" });
		const contract = new TaskContractBuilder("g1")
			.setClaim("Implement X")
			.addRequiredEvidence({
				claim: "File changed",
				category: "feature",
				artifactPath: "src/x.ts",
				verificationCommand: "git diff",
				hash: "abc",
			})
			.setVerdict("pass")
			.build();

		const mergeGate: MergeGateResult = {
			gateId: "fail-closed-merge-gate",
			status: "open",
			reason: "All good",
			evidenceChecked: contract.requiredEvidence,
		};

		const md = reporter.render(contract, mergeGate);
		expect(md).toContain("OMK Verification Report v2");
		expect(md).toContain("Implement X");
		expect(md).toContain("pass");
		expect(md).toContain("open");
	});

	it("escapes pipes and newlines so untrusted text cannot restructure the table", () => {
		const reporter = new VerifyReporterV2({ outputDir: "/tmp/omk-verify", goalId: "g2" });
		const contract = new TaskContractBuilder("g2")
			.setClaim("claim | with pipe\nand newline")
			.addRequiredEvidence({
				claim: "row | injection",
				category: "feature",
				verificationCommand: "echo a | b",
			})
			.build();
		const mergeGate: MergeGateResult = {
			gateId: "evidence-gate",
			status: "blocked",
			reason: "bad | reason",
			evidenceChecked: contract.requiredEvidence,
		};

		const md = reporter.render(contract, mergeGate);
		expect(md).toContain("claim \\| with pipe and newline");
		expect(md).toContain("row \\| injection");
		expect(md).toContain("echo a \\| b");
		expect(md).toContain("bad \\| reason");
	});
});
