import { execFileSync } from "node:child_process";
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
import { EvidenceGate, type EvidenceGateOptions, ReplayLedgerManager } from "../src/guardrails/evidence-system.ts";
import {
	captureWorkspaceFingerprint,
	computeWorkspaceManifestSha256,
} from "../src/guardrails/workspace-fingerprint.ts";
import type {
	ArtifactState,
	EvidenceCommandDescriptor,
	EvidenceReceipt,
	ReplayEvent,
	Sha256Hex,
	TaskContract,
	WorkspaceFingerprint,
	WorkspaceScope,
} from "../src/types/evidence.ts";

const COMMAND: EvidenceCommandDescriptor = { kind: "argv", executable: "node", argv: ["--run", "test"] };
const COMMAND_DIGEST_DOMAIN = "omk:evidence:receipt-v3:command\0";

function commandSha256(command: EvidenceCommandDescriptor) {
	const canonical =
		command.kind === "argv"
			? JSON.stringify({ argv: command.argv, executable: command.executable, kind: command.kind })
			: JSON.stringify({ kind: command.kind, script: command.script, shell: command.shell });
	return parseSha256Hex(createHash("sha256").update(COMMAND_DIGEST_DOMAIN).update(canonical).digest("hex"));
}

function fingerprint(contents: string): WorkspaceFingerprint {
	const scope: WorkspaceScope = { root: "/workspace", artifactPaths: ["dist/result.txt"] };
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

type ContractMetadata = {
	readonly receiptCommandSha256?: Sha256Hex;
	readonly receiptLaneId?: string;
};

type FixtureOverrides = {
	readonly metadata?: ContractMetadata;
	readonly currentFingerprint?: WorkspaceFingerprint;
	readonly receipt?: EvidenceReceipt;
	readonly resolveLedgerEvent?: (seq: number) => ReplayEvent | undefined;
};

describe("EvidenceGate execution bindings", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-evidence-gate-binding-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createFixture(overrides: FixtureOverrides = {}) {
		const binder = createCommandHmacBinder();
		const baseReceipt = createEvidenceReceipt({
			receiptId: "bound-receipt-1",
			goalId: "goal-1",
			laneId: "lane-1",
			claim: "verification passed",
			command: COMMAND,
			commandRedaction: { policyId: "omk-command-redaction-v1", placeholders: [] },
			commandBinding: binder.bind(COMMAND),
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
		const event = ledger.append({
			type: "evidence_receipt",
			goalId: "goal-1",
			laneId: "lane-1",
			payload: evidenceReceiptReplayPayload(baseReceipt),
		});
		ledger.persist();
		const boundReceipt = withEvidenceReceiptEnvelope(baseReceipt, {
			ledgerBinding: { seq: event.seq, eventHash: parseSha256Hex(event.eventHash) },
		});
		const receipt = overrides.receipt ?? boundReceipt;
		const metadata = {
			receiptCommandSha256: commandSha256(COMMAND),
			receiptLaneId: "lane-1",
			...(overrides.metadata ?? {}),
		};
		const evidence = {
			claim: "verification passed",
			category: "feature" as const,
			verificationCommand: "node --run test",
			status: "satisfied" as const,
			timestamp: "2026-07-17T00:00:01.000Z",
			receiptId: receipt.core.receiptId,
			receiptSchemaVersion: 3 as const,
			...metadata,
		};
		const contract: TaskContract = {
			goalId: "goal-1",
			completionClaim: "verification passed",
			requiredEvidence: [evidence],
			finalRisk: "",
			verdict: "pass",
			createdAt: "2026-07-17T00:00:00.000Z",
			updatedAt: "2026-07-17T00:00:01.000Z",
		};
		const options: EvidenceGateOptions = {
			receiptMode: "strict",
			resolveReceipt: () => receipt,
			resolveLedgerEvent:
				overrides.resolveLedgerEvent ?? ((seq: number) => ledger.getEvents().find((e) => e.seq === seq)),
			resolveVerifiedLedgerSnapshot: () => ledger.getVerifiedSnapshot(),
			captureWorkspaceFingerprint: () => overrides.currentFingerprint ?? receipt.core.workspaceAfter,
			commandAttestationBinder: binder,
			resolveAttestedCommand: () => COMMAND,
		};
		return { contract, options, receipt, event };
	}

	it("opens strict mode only when command lane freshness and ledger bindings match", () => {
		// Given: a receipt cross-bound to its evidence metadata, current artifacts, and persisted replay event.
		const fixture = createFixture();

		// When: the strict evidence gate evaluates the contract.
		const result = new EvidenceGate(fixture.options).check(fixture.contract);

		// Then: every execution binding is accepted.
		expect(result.status).toBe("open");
	});

	it("requires one verified ledger snapshot and a command-attestation verifier in strict mode", () => {
		const fixture = createFixture();
		const noSnapshot = { ...fixture.options, resolveVerifiedLedgerSnapshot: undefined };
		expect(new EvidenceGate(noSnapshot).check(fixture.contract).reason).toContain("verified ledger snapshot");
		const noAttestation = { ...fixture.options, commandAttestationBinder: undefined };
		expect(new EvidenceGate(noAttestation).check(fixture.contract).reason).toContain("attestation verifier");
		expect(new EvidenceGate({ ...noAttestation, receiptMode: "prefer" }).check(fixture.contract).status).toBe(
			"conditional",
		);
	});

	it("cryptographically rejects a structurally valid command attestation from another key", () => {
		const foreignBinder = createCommandHmacBinder();
		const receipt = createEvidenceReceipt({
			receiptId: "foreign-binding",
			goalId: "goal-1",
			laneId: "lane-1",
			claim: "verification passed",
			command: COMMAND,
			commandRedaction: { policyId: "omk-command-redaction-v1", placeholders: [] },
			commandBinding: foreignBinder.bind(COMMAND),
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
				stdout: Buffer.alloc(0),
				stderr: Buffer.alloc(0),
			},
			executor: "internal",
		});
		const fixture = createFixture({ receipt });
		const result = new EvidenceGate(fixture.options).check(fixture.contract);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("command attestation");
	});

	it("blocks a command digest mismatch even in prefer mode", () => {
		// Given: evidence metadata names a different command digest.
		const fixture = createFixture({ metadata: { receiptCommandSha256: parseSha256Hex("0".repeat(64)) } });
		const options = { ...fixture.options, receiptMode: "prefer" as const };

		// When: the prefer-mode gate evaluates a tamper-grade mismatch.
		const result = new EvidenceGate(options).check(fixture.contract);

		// Then: prefer mode does not downgrade command tampering to conditional.
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("command");
	});

	it("blocks a lane mismatch", () => {
		// Given: the evidence metadata expects another execution lane.
		const fixture = createFixture({ metadata: { receiptLaneId: "lane-other" } });

		// When: the strict gate evaluates the receipt.
		const result = new EvidenceGate(fixture.options).check(fixture.contract);

		// Then: lane provenance mismatch is explicit.
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("lane");
	});

	it("blocks artifacts changed after verification", () => {
		// Given: the live selected artifact set no longer matches workspaceAfter.
		const fixture = createFixture({ currentFingerprint: fingerprint("changed-after-verification") });

		// When: the strict gate recaptures freshness.
		const result = new EvidenceGate(fixture.options).check(fixture.contract);

		// Then: the stable freshness reason is emitted.
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("artifact-changed-after-verification");
	});

	it("blocks a missing or mismatched replay event", () => {
		// Given: the ledger resolver cannot produce the event bound by the receipt.
		const fixture = createFixture();

		// When: the strict gate's single verified snapshot source fails.
		const result = new EvidenceGate({
			...fixture.options,
			resolveVerifiedLedgerSnapshot: () => {
				throw new Error("synthetic missing ledger snapshot");
			},
		}).check(fixture.contract);

		// Then: ledger binding failure is explicit.
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("ledger");
	});

	it("recaptures git workspaces with the receipt scope so relevant mutations block and out-of-scope changes pass", () => {
		// Given: a receipt whose workspace fingerprints come from a real clean git repository.
		const repo = join(root, "repo");
		mkdirSync(repo);
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: repo,
				encoding: "utf8",
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
			});
		git("init", "--quiet", "-b", "main");
		git("config", "user.email", "evidence@omk.test");
		git("config", "user.name", "OMK Evidence");
		git("config", "commit.gpgsign", "false");
		mkdirSync(join(repo, "dist"));
		writeFileSync(join(repo, ".gitignore"), "dist/ignored.txt\n");
		writeFileSync(join(repo, "dist", "assume.txt"), "assume-v1\n");
		writeFileSync(join(repo, "dist", "result.txt"), "tracked-v1\n");
		writeFileSync(join(repo, "dist", "skip.txt"), "skip-v1\n");
		writeFileSync(join(repo, "other.txt"), "out-of-scope-v1\n");
		git("add", ".");
		git("commit", "--quiet", "-m", "baseline");
		writeFileSync(join(repo, "dist", "ignored.txt"), "ignored-v1\n");
		git("update-index", "--assume-unchanged", "dist/assume.txt");
		git("update-index", "--skip-worktree", "dist/skip.txt");
		const scope = {
			root: repo,
			artifactPaths: [
				"dist/assume.txt",
				"dist/ignored.txt",
				"dist/result.txt",
				"dist/skip.txt",
				"dist/untracked.txt",
			],
		};
		const gitFingerprint = captureWorkspaceFingerprint(scope);
		expect(gitFingerprint.kind).toBe("git");
		const binder = createCommandHmacBinder();
		const receipt = createEvidenceReceipt({
			receiptId: "git-bound-receipt-1",
			goalId: "goal-1",
			laneId: "lane-1",
			claim: "verification passed",
			command: COMMAND,
			commandRedaction: { policyId: "omk-command-redaction-v1", placeholders: [] },
			commandBinding: binder.bind(COMMAND),
			cwd: repo,
			timeoutMs: 30_000,
			startedAt: "2026-07-17T00:00:00.000Z",
			finishedAt: "2026-07-17T00:00:01.000Z",
			durationMs: 1_000,
			status: "passed",
			exitCode: 0,
			workspaceBefore: gitFingerprint,
			workspaceAfter: captureWorkspaceFingerprint(scope),
			alreadyRedactedOutput: {
				redactionPolicyId: "test-policy-v1",
				stdout: Buffer.alloc(0),
				stderr: Buffer.alloc(0),
			},
			executor: "internal",
		});
		const ledger = new ReplayLedgerManager("goal-1", join(root, "git-ledger.jsonl"));
		const event = ledger.append({
			type: "evidence_receipt",
			goalId: "goal-1",
			laneId: "lane-1",
			payload: evidenceReceiptReplayPayload(receipt),
		});
		const boundReceipt = withEvidenceReceiptEnvelope(receipt, {
			ledgerBinding: { seq: event.seq, eventHash: parseSha256Hex(event.eventHash) },
		});
		const contract: TaskContract = {
			goalId: "goal-1",
			completionClaim: "verification passed",
			requiredEvidence: [
				{
					claim: "verification passed",
					category: "feature",
					status: "satisfied",
					timestamp: "2026-07-17T00:00:01.000Z",
					receiptId: boundReceipt.core.receiptId,
					receiptSchemaVersion: 3,
					receiptCommandSha256: commandSha256(COMMAND),
					receiptLaneId: "lane-1",
				},
			],
			finalRisk: "",
			verdict: "pass",
			createdAt: "2026-07-17T00:00:00.000Z",
			updatedAt: "2026-07-17T00:00:01.000Z",
		};
		const gate = new EvidenceGate({
			receiptMode: "strict",
			resolveReceipt: () => boundReceipt,
			resolveLedgerEvent: (seq) => ledger.getEvents().find((candidate) => candidate.seq === seq),
			resolveVerifiedLedgerSnapshot: () => ledger.getVerifiedSnapshot(),
			captureWorkspaceFingerprint,
			commandAttestationBinder: binder,
			resolveAttestedCommand: () => COMMAND,
		});

		// Then: the untouched git workspace passes the same-scope recapture.
		expect(gate.check(contract).status).toBe("open");

		// When/Then: out-of-scope mutations keep the gate open per the selected scope.
		writeFileSync(join(repo, "other.txt"), "out-of-scope-v2\n");
		writeFileSync(join(repo, "unrelated.txt"), "new-out-of-scope\n");
		expect(gate.check(contract).status).toBe("open");

		// When/Then: ignored and index-flagged selected bytes block despite a clean Git status.
		for (const [path, changed, original] of [
			["dist/ignored.txt", "ignored-v2\n", "ignored-v1\n"],
			["dist/assume.txt", "assume-v2\n", "assume-v1\n"],
			["dist/skip.txt", "skip-v2\n", "skip-v1\n"],
		] as const) {
			writeFileSync(join(repo, path), changed);
			const hiddenMutation = gate.check(contract);
			expect(hiddenMutation.status).toBe("blocked");
			expect(hiddenMutation.reason).toContain("artifact-changed-after-verification");
			writeFileSync(join(repo, path), original);
			expect(gate.check(contract).status).toBe("open");
		}

		// When/Then: a post-receipt unstaged relevant mutation blocks.
		writeFileSync(join(repo, "dist", "result.txt"), "tracked-dirty\n");
		const unstaged = gate.check(contract);
		expect(unstaged.status).toBe("blocked");
		expect(unstaged.reason).toContain("artifact-changed-after-verification");

		// When/Then: staging the same mutation still blocks.
		git("add", "dist/result.txt");
		expect(gate.check(contract).status).toBe("blocked");

		// When/Then: reverting and adding a relevant untracked artifact blocks.
		git("reset", "--quiet", "--hard", "HEAD");
		expect(gate.check(contract).status).toBe("open");
		writeFileSync(join(repo, "dist", "untracked.txt"), "untracked-v1\n");
		const untracked = gate.check(contract);
		expect(untracked.status).toBe("blocked");
		expect(untracked.reason).toContain("artifact-changed-after-verification");

		// When/Then: flipping the workspace kind after the receipt fails closed.
		rmSync(join(repo, "dist", "untracked.txt"));
		expect(gate.check(contract).status).toBe("open");
		rmSync(join(repo, ".git"), { recursive: true, force: true });
		const flipped = gate.check(contract);
		expect(flipped.status).toBe("blocked");
		expect(flipped.reason).toMatch(/kind/);
	});

	it("blocks strict mode when execution-binding metadata is absent", () => {
		// Given: a valid core receipt without ledger, command, or lane metadata bindings.
		const bareReceipt = createEvidenceReceipt({
			...createFixture().receipt.core,
			alreadyRedactedOutput: {
				redactionPolicyId: "test-policy-v1",
				stdout: Buffer.alloc(0),
				stderr: Buffer.alloc(0),
			},
		});
		const fixture = createFixture({ receipt: bareReceipt, metadata: {} });
		delete fixture.contract.requiredEvidence[0].receiptCommandSha256;
		delete fixture.contract.requiredEvidence[0].receiptLaneId;

		// When: strict mode evaluates the unbound receipt.
		const result = new EvidenceGate(fixture.options).check(fixture.contract);

		// Then: missing execution bindings block release evidence.
		expect(result.status).toBe("blocked");
		expect(result.reason).toMatch(/binding|command|ledger/);
	});
});
