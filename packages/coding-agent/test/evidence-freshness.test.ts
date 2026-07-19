import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandHmacBinder } from "../src/guardrails/evidence-attestation.ts";
import {
	createEvidenceReceipt,
	evidenceReceiptReplayPayload,
	parseSha256Hex,
	withEvidenceReceiptEnvelope,
} from "../src/guardrails/evidence-receipt.ts";
import { EvidenceReceiptStore } from "../src/guardrails/evidence-receipt-store.ts";
import {
	EvidenceGate,
	latestRelevantWorkspaceMutationSeq,
	ReplayLedgerManager,
} from "../src/guardrails/evidence-system.ts";
import { VerifiedEvidenceExecutor } from "../src/guardrails/verified-executor.ts";
import { computeWorkspaceManifestSha256 } from "../src/guardrails/workspace-fingerprint.ts";
import type {
	ArtifactState,
	EvidenceReceipt,
	TaskContract,
	WorkspaceFingerprint,
	WorkspaceScope,
} from "../src/types/evidence.ts";

const SCOPE: WorkspaceScope = { root: "/workspace", artifactPaths: ["dist/result.txt"] };

function sha256(value: string) {
	return parseSha256Hex(createHash("sha256").update(value).digest("hex"));
}

function fingerprint(contents: string): WorkspaceFingerprint {
	const artifacts: ArtifactState[] = [
		{ path: "dist/result.txt", state: "file", sha256: sha256(contents), size: Buffer.byteLength(contents) },
	];
	return {
		kind: "artifact-set",
		scope: SCOPE,
		artifacts,
		manifestSha256: computeWorkspaceManifestSha256(SCOPE, artifacts),
	};
}

function contractFor(receipt: EvidenceReceipt, receiptCommandSha256: ReturnType<typeof sha256>): TaskContract {
	return {
		goalId: "goal-1",
		completionClaim: "verification passed",
		requiredEvidence: [
			{
				claim: "verification passed",
				category: "feature",
				status: "satisfied",
				timestamp: "2026-07-17T00:00:01.000Z",
				receiptId: receipt.core.receiptId,
				receiptSchemaVersion: 3,
				receiptCommandSha256,
				receiptLaneId: "lane-1",
			},
		],
		finalRisk: "",
		verdict: "pass",
		createdAt: "2026-07-17T00:00:00.000Z",
		updatedAt: "2026-07-17T00:00:01.000Z",
	};
}

describe("EvidenceGate ledger-sequence freshness", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-evidence-freshness-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createFixture(options: { bindReceipt?: boolean } = {}) {
		const bindReceipt = options.bindReceipt ?? true;
		const binder = createCommandHmacBinder();
		const command = { kind: "argv" as const, executable: "node", argv: ["--run", "test"] };
		const baseReceipt = createEvidenceReceipt({
			receiptId: "fresh-receipt-1",
			goalId: "goal-1",
			laneId: "lane-1",
			claim: "verification passed",
			command,
			commandRedaction: { policyId: "omk-command-redaction-v1", placeholders: [] },
			commandBinding: binder.bind(command),
			cwd: "/workspace",
			timeoutMs: 30_000,
			startedAt: "2026-07-17T00:00:00.000Z",
			finishedAt: "2026-07-17T00:00:01.000Z",
			durationMs: 1_000,
			status: "passed",
			exitCode: 0,
			workspaceBefore: fingerprint("before"),
			workspaceAfter: fingerprint("after"),
			alreadyRedactedOutput: {
				redactionPolicyId: "test-policy-v1",
				stdout: Buffer.from("ok\n"),
				stderr: Buffer.alloc(0),
			},
			executor: "internal",
		});
		const ledger = new ReplayLedgerManager("goal-1", join(root, "ledger.jsonl"));
		// A relevant workspace mutation precedes the receipt, so seq 1 is a mutation
		// and the receipt is bound at seq 2.
		ledger.append({
			type: "workspace_mutation",
			goalId: "goal-1",
			laneId: "lane-1",
			payload: { root: SCOPE.root, paths: ["dist/result.txt"] },
		});
		const event = ledger.append({
			type: "evidence_receipt",
			goalId: "goal-1",
			laneId: "lane-1",
			payload: evidenceReceiptReplayPayload(baseReceipt),
		});
		ledger.persist();
		const receipt = bindReceipt
			? withEvidenceReceiptEnvelope(baseReceipt, {
					ledgerBinding: { seq: event.seq, eventHash: parseSha256Hex(event.eventHash) },
				})
			: baseReceipt;
		const commandSha = parseSha256Hex(
			createHash("sha256")
				.update("omk:evidence:receipt-v3:command\0")
				.update(JSON.stringify({ argv: ["--run", "test"], executable: "node", kind: "argv" }))
				.digest("hex"),
		);
		const contract = contractFor(receipt, commandSha);
		const gateOptions = {
			receiptMode: "strict" as const,
			resolveReceipt: () => receipt,
			resolveLedgerEvent: (seq: number) => ledger.getEvents().find((candidate) => candidate.seq === seq),
			resolveVerifiedLedgerSnapshot: () => ledger.getVerifiedSnapshot(),
			captureWorkspaceFingerprint: () => receipt.core.workspaceAfter,
			commandAttestationBinder: binder,
			resolveAttestedCommand: () => command,
		};
		return { contract, gateOptions, receipt, receiptSeq: event.seq, ledger };
	}

	it("uses the verified ledger snapshot as the required mutation-order source", () => {
		const fixture = createFixture();
		expect(new EvidenceGate(fixture.gateOptions).check(fixture.contract).status).toBe("open");
		const result = new EvidenceGate({
			...fixture.gateOptions,
			resolveVerifiedLedgerSnapshot: undefined,
		}).check(fixture.contract);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("verified ledger snapshot");
	});

	it("stays open when the source reports no relevant workspace mutation", () => {
		// Given: a freshness source that has no relevant mutation.
		const fixture = createFixture();

		// When: the gate evaluates with an empty source.
		const result = new EvidenceGate({
			...fixture.gateOptions,
			resolveLatestWorkspaceMutationSeq: () => null,
		}).check(fixture.contract);

		// Then: no mutation means the receipt is fresh.
		expect(result.status).toBe("open");
	});

	it("stays open when the receipt ledger seq exceeds the latest relevant mutation seq", () => {
		// Given: a relevant mutation at seq 1 and the receipt bound at seq 2.
		const fixture = createFixture();
		expect(fixture.receiptSeq).toBe(2);

		// When: the gate compares the sequences.
		const result = new EvidenceGate({
			...fixture.gateOptions,
			resolveLatestWorkspaceMutationSeq: () => 1,
		}).check(fixture.contract);

		// Then: the receipt post-dates the mutation.
		expect(result.status).toBe("open");
	});

	it.each([{ mutationSeq: 2 }, { mutationSeq: 5 }])(
		"hard-blocks when a relevant mutation seq $mutationSeq does not precede the receipt seq",
		({ mutationSeq }) => {
			// Given: a mutation recorded at or after the receipt event.
			const fixture = createFixture();

			// When: even the prefer-mode gate evaluates staleness.
			const result = new EvidenceGate({
				...fixture.gateOptions,
				receiptMode: "prefer",
				resolveVerifiedLedgerSnapshot: undefined,
				resolveLatestWorkspaceMutationSeq: () => mutationSeq,
			}).check(fixture.contract);

			// Then: staleness is a hard block, not a conditional gap.
			expect(result.status).toBe("blocked");
			expect(result.reason).toMatch(/stale|mutation/);
		},
	);

	it("hard-blocks when the mutation source throws, even in prefer mode", () => {
		// Given: a freshness source that fails.
		const fixture = createFixture();

		// When: the prefer-mode gate consults the failing source.
		const result = new EvidenceGate({
			...fixture.gateOptions,
			receiptMode: "prefer",
			resolveVerifiedLedgerSnapshot: undefined,
			resolveLatestWorkspaceMutationSeq: () => {
				throw new Error("synthetic mutation source failure");
			},
		}).check(fixture.contract);

		// Then: a broken source fails closed.
		expect(result.status).toBe("blocked");
		expect(result.reason).toMatch(/mutation/);
	});

	it.each([{ value: 0 }, { value: -1 }, { value: 1.5 }, { value: Number.NaN }, { value: "2" }, { value: {} }])(
		"hard-blocks the malformed mutation source result $value",
		({ value }) => {
			// Given: a freshness source that returns an out-of-contract value.
			const fixture = createFixture();

			// When: the prefer-mode gate consults the malformed source.
			const result = new EvidenceGate({
				...fixture.gateOptions,
				receiptMode: "prefer",
				resolveVerifiedLedgerSnapshot: undefined,
				resolveLatestWorkspaceMutationSeq: () => value as number,
			}).check(fixture.contract);

			// Then: malformed freshness data fails closed.
			expect(result.status).toBe("blocked");
			expect(result.reason).toMatch(/mutation/);
		},
	);

	it("hard-blocks a known relevant mutation when the receipt has no ledger binding", () => {
		// Given: an unbound receipt is only a conditional gap without a freshness source.
		const fixture = createFixture({ bindReceipt: false });
		const baseline = new EvidenceGate({
			...fixture.gateOptions,
			receiptMode: "prefer",
			resolveVerifiedLedgerSnapshot: undefined,
		}).check(fixture.contract);
		expect(baseline.status).toBe("conditional");

		// When: a relevant mutation is known but the receipt seq cannot be proven newer.
		const result = new EvidenceGate({
			...fixture.gateOptions,
			receiptMode: "prefer",
			resolveVerifiedLedgerSnapshot: undefined,
			resolveLatestWorkspaceMutationSeq: () => 1,
		}).check(fixture.contract);

		// Then: the unprovable ordering fails closed.
		expect(result.status).toBe("blocked");
	});

	it("resolves the latest relevant mutation seq from replay events fail-closed", () => {
		// Given: a ledger mixing mutations, receipts, and malformed payloads.
		const ledger = new ReplayLedgerManager("goal-1", join(root, "resolver-ledger.jsonl"));
		const append = (payload: unknown) => ledger.append({ type: "workspace_mutation", goalId: "goal-1", payload }).seq;
		ledger.append({ type: "tool_call", goalId: "goal-1", payload: { name: "bash" } });
		const exactSeq = append({ root: SCOPE.root, paths: ["dist/result.txt"] });
		const outOfScopeSeq = append({ root: SCOPE.root, paths: ["docs/readme.md"] });
		expect(latestRelevantWorkspaceMutationSeq(ledger.getEvents(), SCOPE)).toBe(exactSeq);
		expect(outOfScopeSeq).toBeGreaterThan(exactSeq);

		// When/Then: directory-prefix overlap in either direction is relevant.
		const parentSeq = append({ root: SCOPE.root, paths: ["dist"] });
		expect(latestRelevantWorkspaceMutationSeq(ledger.getEvents(), SCOPE)).toBe(parentSeq);
		const childSeq = append({ root: SCOPE.root, paths: ["dist/result.txt/part"] });
		expect(latestRelevantWorkspaceMutationSeq(ledger.getEvents(), SCOPE)).toBe(childSeq);

		// When/Then: a foreign root or malformed payload cannot prove irrelevance.
		const foreignRootSeq = append({ root: "/elsewhere", paths: ["docs/readme.md"] });
		expect(latestRelevantWorkspaceMutationSeq(ledger.getEvents(), SCOPE)).toBe(foreignRootSeq);
		const malformedSeq = append({ paths: "dist/result.txt" });
		expect(latestRelevantWorkspaceMutationSeq(ledger.getEvents(), SCOPE)).toBe(malformedSeq);

		// When/Then: provably out-of-scope mutations never advance the relevant seq.
		append({ root: SCOPE.root, paths: ["docs/readme.md", "src/index.ts"] });
		expect(latestRelevantWorkspaceMutationSeq(ledger.getEvents(), SCOPE)).toBe(malformedSeq);
		expect(latestRelevantWorkspaceMutationSeq([], SCOPE)).toBeNull();
	});

	it("blocks a stale receipt through the executor gate options after a later relevant mutation", async () => {
		// Given: a real executor run whose receipt is bound at seq 1.
		const workspaceRoot = join(root, "workspace");
		mkdirSync(workspaceRoot);
		const ledger = new ReplayLedgerManager("goal-exec", join(root, "exec-ledger", "events.jsonl"));
		const executor = new VerifiedEvidenceExecutor({
			store: new EvidenceReceiptStore(join(root, "exec-receipts")),
			ledger,
		});
		const scope: WorkspaceScope = { root: workspaceRoot, artifactPaths: ["dist/result.txt"] };
		const execution = await executor.execute({
			goalId: "goal-exec",
			laneId: "lane-1",
			claim: "verification passed",
			command: { kind: "argv", executable: "node", argv: ["--run", "test"] },
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			workspaceScope: scope,
			executor: "internal",
			execute: async () => {
				mkdirSync(join(workspaceRoot, "dist"));
				writeFileSync(join(workspaceRoot, "dist", "result.txt"), "verified\n");
				return {
					status: "passed",
					exitCode: 0,
					alreadyRedactedOutput: {
						redactionPolicyId: "test-policy-v1",
						stdout: Buffer.alloc(0),
						stderr: Buffer.alloc(0),
					},
				};
			},
		});
		const contract: TaskContract = {
			goalId: "goal-exec",
			completionClaim: "verification passed",
			requiredEvidence: [
				{
					claim: "verification passed",
					category: "feature",
					status: "satisfied",
					timestamp: "2026-07-17T00:00:01.000Z",
					receiptId: execution.evidenceMetadata.receiptId,
					receiptSchemaVersion: 3,
					receiptCommandSha256: execution.evidenceMetadata.receiptCommandSha256,
					receiptLaneId: "lane-1",
				},
			],
			finalRisk: "",
			verdict: "pass",
			createdAt: "2026-07-17T00:00:00.000Z",
			updatedAt: "2026-07-17T00:00:01.000Z",
		};
		const gate = new EvidenceGate({ receiptMode: "strict", ...executor.createGateOptions() });
		expect(gate.check(contract).status).toBe("open");

		// When: an out-of-scope mutation lands after the receipt.
		ledger.append({
			type: "workspace_mutation",
			goalId: "goal-exec",
			payload: { root: workspaceRoot, paths: ["docs/readme.md"] },
		});
		ledger.persist();

		// Then: the scoped freshness source keeps the gate open.
		expect(gate.check(contract).status).toBe("open");

		// When: a relevant mutation lands after the receipt.
		ledger.append({
			type: "workspace_mutation",
			goalId: "goal-exec",
			payload: { root: workspaceRoot, paths: ["dist/result.txt"] },
		});
		ledger.persist();

		// Then: the receipt is stale and the gate fails closed.
		const stale = gate.check(contract);
		expect(stale.status).toBe("blocked");
		expect(stale.reason).toMatch(/stale|mutation/);
	});
});
