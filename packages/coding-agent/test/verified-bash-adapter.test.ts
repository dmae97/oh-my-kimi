import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/core/redaction.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import {
	EvidenceGate,
	EvidenceReceiptStore,
	executeVerifiedBash,
	ReplayLedgerManager,
	TaskContractBuilder,
	VERIFIED_BASH_REDACTION_POLICY_ID,
	VerifiedBashAdapterError,
	VerifiedEvidenceExecutor,
} from "../src/index.ts";
import type { WorkspaceScope } from "../src/types/evidence.ts";

const GOAL_ID = "goal-verified-bash";
const CLAIM = "verified bash completed";
const SHELL = "/bin/sh";
const SCRIPT = "node --run focused-test";

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("executeVerifiedBash", () => {
	let root: string;
	let workspaceRoot: string;
	let receiptRoot: string;
	let ledgerPath: string;
	let workspaceScope: WorkspaceScope;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-verified-bash-"));
		workspaceRoot = join(root, "workspace");
		receiptRoot = join(root, "receipts");
		ledgerPath = join(root, "ledger", "events.jsonl");
		workspaceScope = { root: workspaceRoot, artifactPaths: ["dist/result.txt"] };
		mkdirSync(workspaceRoot);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createExecutor(receiptId: string) {
		const instants = [new Date("2026-07-17T01:00:00.000Z"), new Date("2026-07-17T01:00:01.000Z")];
		return new VerifiedEvidenceExecutor({
			store: new EvidenceReceiptStore(receiptRoot),
			ledger: new ReplayLedgerManager(GOAL_ID, ledgerPath),
			now: () => {
				const instant = instants.shift();
				if (!instant) throw new Error("deterministic test clock exhausted");
				return instant;
			},
			receiptIdFactory: () => receiptId,
		});
	}

	function request(evidenceExecutor: VerifiedEvidenceExecutor, operations: BashOperations) {
		return {
			evidenceExecutor,
			operations,
			goalId: GOAL_ID,
			laneId: "lane-bash",
			claim: CLAIM,
			shell: SHELL,
			script: SCRIPT,
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			workspaceScope,
			toolCallId: "tool-bash-1",
		};
	}

	it("binds the exact shell script, redacted combined output, artifacts, and strict gate", async () => {
		// Given: a trusted runner that emits a secret-shaped value and creates the selected artifact.
		const rawOutput = Buffer.from("token=super-secret-value\nverification passed\n");
		let observedScript = "";
		const operations: BashOperations = {
			exec: async (script, cwd, options) => {
				observedScript = script;
				options.onData(rawOutput);
				mkdirSync(join(cwd, "dist"));
				writeFileSync(join(cwd, "dist", "result.txt"), "verified\n");
				return { exitCode: 0 };
			},
		};
		const evidenceExecutor = createExecutor("verified-bash-pass");

		// When: the opt-in adapter executes the runner.
		const result = await executeVerifiedBash(request(evidenceExecutor, operations));

		// Then: the receipt binds exactly what reached the runner and only redacted combined bytes.
		expect(observedScript).toBe(SCRIPT);
		expect(result.receipt.core.command).toEqual({ kind: "shell", shell: SHELL, script: SCRIPT });
		expect(VERIFIED_BASH_REDACTION_POLICY_ID).toBe(
			"omk-bash-combined-v1+omk-sensitive-text-v1+capture-tail-128k+tail-64k",
		);
		expect(result.receipt.core.output.redactionPolicyId).toBe(VERIFIED_BASH_REDACTION_POLICY_ID);
		const redacted = Buffer.from(redactSensitiveText(rawOutput.toString("utf8")));
		expect(result.receipt.core.output.stdout).toEqual({ sha256: sha256(redacted), byteCount: redacted.byteLength });
		expect(result.receipt.core.output.stderr.byteCount).toBe(0);
		expect(result.receipt.core.workspaceAfter.artifacts[0].state).toBe("file");

		const contract = new TaskContractBuilder(GOAL_ID)
			.setClaim(CLAIM)
			.addRequiredEvidence({
				claim: CLAIM,
				category: "feature",
				receiptId: result.evidenceMetadata.receiptId,
				receiptSchemaVersion: 3,
				receiptCommandSha256: result.evidenceMetadata.receiptCommandSha256,
				receiptLaneId: result.evidenceMetadata.receiptLaneId,
			})
			.updateEvidenceStatus(CLAIM, "satisfied")
			.setVerdict("pass")
			.build();
		const gate = new EvidenceGate({ receiptMode: "strict", ...evidenceExecutor.createGateOptions() });
		expect(gate.check(contract).status).toBe("open");
		writeFileSync(join(workspaceRoot, "dist", "result.txt"), "changed\n");
		expect(gate.check(contract).reason).toContain("artifact-changed-after-verification");
	});

	it.each([
		{ name: "failed", run: async () => ({ exitCode: 7 }), status: "failed", exitCode: 7 },
		{
			name: "timeout",
			run: async () => {
				throw new Error("timeout:30");
			},
			status: "timeout",
			exitCode: null,
		},
		{
			name: "aborted",
			run: async () => {
				throw new Error("aborted");
			},
			status: "aborted",
			exitCode: null,
		},
	] as const)("maps the $name runner terminal state", async ({ run, status, exitCode }) => {
		// Given: a runner with a normalized built-in terminal outcome.
		const operations: BashOperations = { exec: run };
		const evidenceExecutor = createExecutor(`verified-bash-${status}`);

		// When: the adapter records the outcome.
		const result = await executeVerifiedBash(request(evidenceExecutor, operations));

		// Then: the receipt preserves the expected disposition.
		expect(result.receipt.core.status).toBe(status);
		expect(result.receipt.core.exitCode).toBe(exitCode);
	});

	it("returns aborted without invoking a runner when the signal is already aborted", async () => {
		// Given: an already-aborted signal and an observable runner.
		let executions = 0;
		const operations: BashOperations = {
			exec: async () => {
				executions++;
				return { exitCode: 0 };
			},
		};
		const controller = new AbortController();
		controller.abort();

		// When: the adapter receives the aborted signal.
		const result = await executeVerifiedBash({
			...request(createExecutor("verified-bash-aborted"), operations),
			signal: controller.signal,
		});

		// Then: no process starts and the receipt is terminally aborted.
		expect(executions).toBe(0);
		expect(result.receipt.core).toMatchObject({ status: "aborted", exitCode: null });
	});

	it("executes the original secret-bearing script and persists only the redacted representation", async () => {
		// Given: a script containing an inline credential and an observing runner.
		const secretScript =
			"curl -H 'Authorization: Bearer synthetic-adapter-secret-token' https://example.invalid && mkdir -p dist";
		let observedScript = "";
		const operations: BashOperations = {
			exec: async (script) => {
				observedScript = script;
				return { exitCode: 0 };
			},
		};

		// When: the adapter executes the runner with the secret-bearing script.
		const result = await executeVerifiedBash({
			...request(createExecutor("verified-bash-secret"), operations),
			script: secretScript,
		});

		// Then: the runner received the original while the receipt persisted the tokenized form.
		expect(observedScript).toBe(secretScript);
		expect(result.receipt.core.command).toEqual({
			kind: "shell",
			shell: SHELL,
			script: "curl -H 'Authorization: Bearer [REDACTED]' https://example.invalid && mkdir -p dist",
		});
		expect(result.receipt.core.commandRedaction?.placeholders).toEqual([{ type: "authorization-header", count: 1 }]);
		expect(result.receipt.core.commandBinding?.algorithm).toBe("hmac-sha256");
		expect(new ReplayLedgerManager(GOAL_ID, ledgerPath).getEvents()).toHaveLength(1);
		expect(readFileSync(result.receiptPath, "utf8")).not.toContain("synthetic-adapter-secret-token");
	});

	it("fails closed before the runner when redaction metadata would be oversize", async () => {
		// Given: a script with more inline secrets than the placeholder metadata bound allows.
		let executions = 0;
		const operations: BashOperations = {
			exec: async () => {
				executions++;
				return { exitCode: 0 };
			},
		};

		// When/Then: redaction fails before the runner side effect and no ledger event exists.
		await expect(
			executeVerifiedBash({
				...request(createExecutor("verified-bash-oversize"), operations),
				script: Array.from({ length: 300 }, (_, index) => `tool --token synthetic-oversize-${index}`).join("; "),
			}),
		).rejects.toThrow(/placeholder/i);
		expect(executions).toBe(0);
		expect(new ReplayLedgerManager(GOAL_ID, ledgerPath).getEvents()).toHaveLength(0);
	});

	it.each([null, Number.NaN, 1.5])("rejects invalid runner exit code %s without a ledger event", async (exitCode) => {
		// Given: a runner that violates the BashOperations exit-code contract.
		const operations: BashOperations = { exec: async () => ({ exitCode }) };

		// When/Then: the adapter fails closed with its typed boundary error.
		await expect(
			executeVerifiedBash(request(createExecutor("verified-bash-invalid-exit"), operations)),
		).rejects.toBeInstanceOf(VerifiedBashAdapterError);
		expect(new ReplayLedgerManager(GOAL_ID, ledgerPath).getEvents()).toHaveLength(0);
	});

	it("leaves no ledger event when the runner throws an unknown error", async () => {
		// Given: a runner that fails outside the known terminal protocol.
		const operations: BashOperations = {
			exec: async () => {
				throw new TypeError("runner exploded");
			},
		};

		// When/Then: the unknown error propagates without a fabricated receipt event.
		await expect(executeVerifiedBash(request(createExecutor("verified-bash-error"), operations))).rejects.toThrow(
			"runner exploded",
		);
		expect(new ReplayLedgerManager(GOAL_ID, ledgerPath).getEvents()).toHaveLength(0);
	});

	it("bounds redacted combined output to the receipt byte limit", async () => {
		// Given: output larger than the receipt budget with a secret-shaped tail.
		const rawOutput = Buffer.from(`${"x".repeat(70_000)}\ntoken=tail-secret\n`);
		const operations: BashOperations = {
			exec: async (_script, _cwd, options) => {
				options.onData(rawOutput);
				return { exitCode: 0 };
			},
		};

		// When: the adapter records the successful run.
		const result = await executeVerifiedBash(request(createExecutor("verified-bash-bounded"), operations));

		// Then: the digest covers the deterministic redacted tail and stderr remains explicitly merged.
		const redacted = Buffer.from(redactSensitiveText(rawOutput.toString("utf8")));
		const bounded = redacted.subarray(-64 * 1024);
		expect(result.receipt.core.output.stdout).toEqual({ sha256: sha256(bounded), byteCount: bounded.byteLength });
		expect(result.receipt.core.output.stderr.byteCount).toBe(0);
	});
});
