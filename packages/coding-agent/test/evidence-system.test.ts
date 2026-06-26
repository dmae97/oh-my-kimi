import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
	EvidenceGate,
	FailClosedMergeGate,
	ReplayLedgerManager,
	TaskContractBuilder,
	VerifyReporterV2,
} from "../src/guardrails/evidence-system.ts";
import type { EvidenceItem, TaskContract } from "../src/types/evidence.ts";

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
});

describe("ReplayLedgerManager", () => {
	const tmpPath = "/tmp/omk-test-ledger.jsonl";
	const tmpPathReplay = "/tmp/omk-test-ledger-replay.jsonl";
	beforeEach(() => {
		try {
			rmSync(tmpPath);
		} catch {
			/* ignore */
		}
		try {
			rmSync(tmpPathReplay);
		} catch {
			/* ignore */
		}
	});

	it("appends and persists events", () => {
		const ledger = new ReplayLedgerManager("goal-ledger", tmpPath);
		ledger.append({
			type: "session_start",
			goalId: "goal-ledger",
			payload: { message: "hello" },
		});
		ledger.append({
			type: "tool_call",
			goalId: "goal-ledger",
			laneId: "lane-1",
			payload: { tool: "read_file" },
		});
		ledger.persist();

		expect(ledger.getEvents()).toHaveLength(2);
		expect(ledger.getEvents()[0].seq).toBe(1);
		expect(ledger.getEvents()[1].seq).toBe(2);
		expect(ledger.getEvents()[1].payloadHash).toBeDefined();

		// Reload and verify
		const ledger2 = new ReplayLedgerManager("goal-ledger", tmpPath);
		expect(ledger2.getEvents()).toHaveLength(2);
	});

	it("replays events with handler", () => {
		const ledger = new ReplayLedgerManager("goal-replay", tmpPathReplay);
		ledger.append({ type: "tool_call", goalId: "goal-replay", payload: { tool: "A" } });
		ledger.append({ type: "tool_call", goalId: "goal-replay", payload: { tool: "B" } });
		ledger.append({ type: "message", goalId: "goal-replay", payload: { text: "hi" } });

		const tools = ledger.replay((ev) =>
			ev.type === "tool_call" ? (ev.payload as { tool: string }).tool : undefined,
		);
		expect(tools).toEqual(["A", "B"]);
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
		const gate = new EvidenceGate();
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
		const gate = new EvidenceGate();
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
		const mergeGate = new FailClosedMergeGate();
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
		(contract as any).verdict = "fail";
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

		const mergeGate: import("../src/types/evidence.ts").MergeGateResult = {
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
});
