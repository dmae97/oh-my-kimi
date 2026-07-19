import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeEvidenceCommandSha256,
	parseEvidenceReceiptCore,
	serializeEvidenceReceipt,
} from "../src/guardrails/evidence-receipt.ts";
import { EvidenceReceiptStore } from "../src/guardrails/evidence-receipt-store.ts";
import { ReplayLedgerManager } from "../src/guardrails/evidence-system.ts";
import type { VerifiedEvidenceExecutionOutcome } from "../src/guardrails/verified-executor.ts";
import { VerifiedEvidenceExecutor } from "../src/guardrails/verified-executor.ts";
import { computeWorkspaceManifestSha256 } from "../src/guardrails/workspace-fingerprint.ts";
import type {
	ArtifactState,
	EvidenceReceiptDisposition,
	WorkspaceFingerprint,
	WorkspaceScope,
} from "../src/types/evidence.ts";

describe("VerifiedEvidenceExecutor", () => {
	let root: string;
	let workspaceRoot: string;
	let receiptRoot: string;
	let ledgerPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-verified-executor-"));
		workspaceRoot = join(root, "workspace");
		receiptRoot = join(root, "receipts");
		ledgerPath = join(root, "ledger", "events.jsonl");
		mkdirSync(workspaceRoot);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createExecutor(receiptId: string, store = new EvidenceReceiptStore(receiptRoot)) {
		const instants = [new Date("2026-07-17T00:00:00.000Z"), new Date("2026-07-17T00:00:01.250Z")];
		return new VerifiedEvidenceExecutor({
			store,
			ledger: new ReplayLedgerManager("goal-1", ledgerPath),
			now: () => {
				const instant = instants.shift();
				if (!instant) throw new Error("deterministic test clock exhausted");
				return instant;
			},
			receiptIdFactory: () => receiptId,
		});
	}

	function request(
		execute: () => Promise<
			EvidenceReceiptDisposition & {
				alreadyRedactedOutput: {
					readonly redactionPolicyId: string;
					readonly stdout: Uint8Array;
					readonly stderr: Uint8Array;
				};
			}
		>,
	) {
		const workspaceScope: WorkspaceScope = { root: workspaceRoot, artifactPaths: ["dist/result.txt"] };
		return {
			goalId: "goal-1",
			laneId: "lane-1",
			claim: "focused verification passed",
			command: { kind: "argv" as const, executable: "node", argv: ["--run", "focused-test"] },
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			workspaceScope,
			executor: "internal" as const,
			toolCallId: "tool-call-1",
			execute,
		};
	}

	it("captures actual execution, persists a bound receipt, and returns evidence metadata", async () => {
		// Given: a selected artifact that does not exist before the verification callback.
		let executions = 0;
		const executor = createExecutor("verified-receipt-1");

		// When: the verified callback creates the artifact and reports a passed disposition.
		const result = await executor.execute(
			request(async () => {
				executions++;
				mkdirSync(join(workspaceRoot, "dist"));
				writeFileSync(join(workspaceRoot, "dist", "result.txt"), "verified\n");
				return {
					status: "passed",
					exitCode: 0,
					alreadyRedactedOutput: {
						redactionPolicyId: "test-policy-v1",
						stdout: Buffer.from("ok\n"),
						stderr: Buffer.alloc(0),
					},
				};
			}),
		);

		// Then: before/after, duration, replay binding, store, and contract metadata agree.
		expect(executions).toBe(1);
		expect(result.receipt.core.workspaceBefore.artifacts[0]).toEqual({
			path: "dist/result.txt",
			state: "missing",
		});
		expect(result.receipt.core.workspaceAfter.artifacts[0].state).toBe("file");
		expect(result.receipt.core.durationMs).toBe(1_250);
		expect(result.receipt.envelope.ledgerBinding?.seq).toBe(1);
		expect(result.receiptPath).toContain("verified-receipt-1");
		expect(executor.resolveReceipt(result.receipt.core.receiptId)).toEqual(result.receipt);
		expect(executor.resolveLedgerEvent(1)?.eventHash).toBe(result.receipt.envelope.ledgerBinding?.eventHash);
		expect(result.evidenceMetadata).toMatchObject({
			receiptId: "verified-receipt-1",
			receiptSchemaVersion: 3,
			receiptLaneId: "lane-1",
			timestamp: "2026-07-17T00:00:01.250Z",
		});
		expect(result.evidenceMetadata.receiptCommandSha256).toMatch(/^[0-9a-f]{64}$/);

		const reloaded = new ReplayLedgerManager("goal-1", ledgerPath);
		expect(reloaded.getEvents()[0]).toMatchObject({
			type: "evidence_receipt",
			goalId: "goal-1",
			laneId: "lane-1",
			payload: {
				receiptId: "verified-receipt-1",
				coreSha256: result.receipt.envelope.coreSha256,
			},
		});
	});

	it("rejects invalid scalar request fields before invoking the execution callback", async () => {
		// Given: an invalid empty claim and an observable execution callback.
		let executions = 0;
		const executor = createExecutor("invalid-request");
		const invalidRequest = {
			...request(async () => {
				executions++;
				return {
					status: "passed" as const,
					exitCode: 0 as const,
					alreadyRedactedOutput: {
						redactionPolicyId: "test-policy-v1",
						stdout: Buffer.alloc(0),
						stderr: Buffer.alloc(0),
					},
				};
			}),
			claim: "",
		};

		// When: the invalid request is submitted.
		await expect(executor.execute(invalidRequest)).rejects.toThrow(/claim/);

		// Then: request validation prevented the side effect.
		expect(executions).toBe(0);
	});

	it("rejects an externally inconsistent duration and timestamp interval", async () => {
		// Given: a valid executor-produced receipt core.
		const executor = createExecutor("duration-receipt");
		const result = await executor.execute(
			request(async () => ({
				status: "passed",
				exitCode: 0,
				alreadyRedactedOutput: {
					redactionPolicyId: "test-policy-v1",
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
				},
			})),
		);
		const inconsistentCore = structuredClone(result.receipt.core);
		Object.assign(inconsistentCore, { durationMs: 1 });

		// When/Then: strict receipt parsing rejects the contradictory interval.
		expect(() => parseEvidenceReceiptCore(inconsistentCore)).toThrow(/durationMs/);
	});

	it.each([
		{ status: "failed" as const, exitCode: 7 },
		{ status: "timeout" as const, exitCode: null },
		{ status: "aborted" as const, exitCode: null },
	])("preserves the $status terminal disposition", async (disposition) => {
		// Given: a normalized non-success execution outcome.
		const executor = createExecutor(`verified-${disposition.status}`);

		// When: the outcome is recorded.
		const result = await executor.execute(
			request(async () => ({
				...disposition,
				alreadyRedactedOutput: {
					redactionPolicyId: "test-policy-v1",
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
				},
			})),
		);

		// Then: the immutable receipt carries exactly that terminal disposition.
		expect(result.receipt.core.status).toBe(disposition.status);
		expect(result.receipt.core.exitCode).toBe(disposition.exitCode);
	});

	it("redacts secret-bearing commands, binds the original via HMAC, and persists no secret", async () => {
		// Given: a verification command carrying an inline credential value.
		let executions = 0;
		const executor = createExecutor("redacted-receipt-1");
		const secretRequest = {
			...request(async () => {
				executions++;
				return {
					status: "passed" as const,
					exitCode: 0 as const,
					alreadyRedactedOutput: {
						redactionPolicyId: "test-policy-v1",
						stdout: Buffer.from("ok\n"),
						stderr: Buffer.alloc(0),
					},
				};
			}),
			command: {
				kind: "argv" as const,
				executable: "curl",
				argv: ["--token", "synthetic-executor-secret-value", "https://example.test"],
			},
		};

		// When: the executor records the execution.
		const result = await executor.execute(secretRequest);

		// Then: the callback ran the original request while only the redacted form persisted.
		expect(executions).toBe(1);
		expect(result.receipt.core.command).toEqual({
			kind: "argv",
			executable: "curl",
			argv: ["--token", "[REDACTED]", "https://example.test"],
		});
		expect(result.receipt.core.commandRedaction?.placeholders).toEqual([{ type: "cli-option-value", count: 1 }]);
		expect(result.receipt.core.commandBinding).toMatchObject({ algorithm: "hmac-sha256" });
		expect(result.receipt.core.commandBinding?.mac).toMatch(/^[0-9a-f]{64}$/);
		expect(result.evidenceMetadata.receiptCommandSha256).toBe(
			computeEvidenceCommandSha256(result.receipt.core.command),
		);
		const serialized = serializeEvidenceReceipt(result.receipt);
		const plainCommandHash = createHash("sha256").update(JSON.stringify(secretRequest.command)).digest("hex");
		const unredactedCommandDigest = createHash("sha256")
			.update("omk:evidence:receipt-v3:command\0")
			.update(
				JSON.stringify({
					argv: secretRequest.command.argv,
					executable: secretRequest.command.executable,
					kind: secretRequest.command.kind,
				}),
			)
			.digest("hex");
		expect(serialized).not.toContain("synthetic-executor-secret-value");
		expect(serialized).not.toContain(plainCommandHash);
		expect(serialized).not.toContain(unredactedCommandDigest);
		expect(serialized).toContain("[REDACTED]");
		expect(executor.resolveReceipt("redacted-receipt-1")).toEqual(result.receipt);
	});

	it("normalizes shell-equivalent credential forms without serializing canaries or plain hashes", async () => {
		const canaries = {
			headerEscaped: "header-escaped-canary",
			headerConcatenated: "header-concatenated-canary",
			queryEscaped: "query-escaped-canary",
			queryConcatenated: "query-concatenated-canary",
			queryEncoded: "query-encoded-canary",
			github: `github_pat_${"A".repeat(24)}`,
			google: `AIza${"B".repeat(35)}`,
		};
		const script =
			`printf '%s' X-API-Key\\:${canaries.headerEscaped}; ` +
			`printf '%s' 'X-API-Key':${canaries.headerConcatenated}; ` +
			`printf '%s' ?api_key\\=${canaries.queryEscaped}; ` +
			`printf '%s' '?api_key'=${canaries.queryConcatenated}; ` +
			`printf '%s' '?api%5Fkey=${canaries.queryEncoded}'; ` +
			`printf '%s' ${canaries.github}; printf '%s' ${canaries.google}`;
		const executor = createExecutor("shell-normalized-receipt");

		const result = await executor.execute({
			...request(async () => ({
				status: "passed",
				exitCode: 0,
				alreadyRedactedOutput: {
					redactionPolicyId: "test-policy-v1",
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
				},
			})),
			command: { kind: "shell", shell: "/bin/sh", script },
		});

		expect(result.receipt.core.commandRedaction?.placeholders).toEqual([
			{ type: "api-key-header", count: 2 },
			{ type: "known-token", count: 2 },
			{ type: "url-query", count: 3 },
		]);
		const plainHashes = [
			...Object.values(canaries).map((value) => createHash("sha256").update(value).digest("hex")),
			createHash("sha256").update(script).digest("hex"),
			createHash("sha256")
				.update(JSON.stringify({ kind: "shell", shell: "/bin/sh", script }))
				.digest("hex"),
		];
		for (const serialized of [
			serializeEvidenceReceipt(result.receipt),
			JSON.stringify(result.evidenceMetadata),
			readFileSync(result.receiptPath, "utf8"),
			readFileSync(ledgerPath, "utf8"),
		]) {
			for (const value of [...Object.values(canaries), ...plainHashes]) expect(serialized).not.toContain(value);
		}
	});

	it("records a command binding and empty redaction summary for secret-free commands", async () => {
		const executor = createExecutor("clean-binding-receipt");
		const result = await executor.execute(
			request(async () => ({
				status: "passed",
				exitCode: 0,
				alreadyRedactedOutput: {
					redactionPolicyId: "test-policy-v1",
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
				},
			})),
		);
		expect(result.receipt.core.command).toEqual({
			kind: "argv",
			executable: "node",
			argv: ["--run", "focused-test"],
		});
		expect(result.receipt.core.commandRedaction?.placeholders).toEqual([]);
		expect(result.receipt.core.commandBinding?.algorithm).toBe("hmac-sha256");
	});

	it("fails closed before execution when redacted command metadata would be oversize", async () => {
		// Given: more inline secrets than the placeholder metadata bound allows.
		let executions = 0;
		const executor = createExecutor("oversize-redaction");
		const script = Array.from({ length: 300 }, (_, index) => `tool --token synthetic-oversize-${index}`).join("; ");
		const oversizeRequest = {
			...request(async () => {
				executions++;
				return {
					status: "passed" as const,
					exitCode: 0 as const,
					alreadyRedactedOutput: {
						redactionPolicyId: "test-policy-v1",
						stdout: Buffer.alloc(0),
						stderr: Buffer.alloc(0),
					},
				};
			}),
			command: { kind: "shell" as const, shell: "/bin/sh", script },
		};

		// When/Then: the request is rejected before any side effect or ledger event.
		let message = "";
		try {
			await executor.execute(oversizeRequest);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/placeholder/i);
		expect(message).not.toContain("synthetic-oversize");
		expect(executions).toBe(0);
		expect(new ReplayLedgerManager("goal-1", ledgerPath).getEvents()).toHaveLength(0);
	});

	it("rejects a tampered core whose redaction summary lost its command binding", async () => {
		const executor = createExecutor("binding-consistency");
		const result = await executor.execute(
			request(async () => ({
				status: "passed",
				exitCode: 0,
				alreadyRedactedOutput: {
					redactionPolicyId: "test-policy-v1",
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
				},
			})),
		);
		const tampered = structuredClone(result.receipt.core) as unknown as Record<string, unknown>;
		Object.assign(tampered, {
			commandRedaction: {
				policyId: "omk-command-redaction-v1",
				placeholders: [{ type: "cli-option-value", count: 1 }],
			},
		});
		delete tampered.commandBinding;
		expect(() => parseEvidenceReceiptCore(tampered)).toThrow(/commandBinding/);
	});

	it("keeps executor-captured provenance when the callback returns forged receipt fields", async () => {
		// Given: a callback whose outcome object smuggles forged provenance next to the disposition.
		const forgedScope: WorkspaceScope = { root: "/forged", artifactPaths: ["forged.txt"] };
		const forgedArtifacts: ArtifactState[] = [{ path: "forged.txt", state: "missing" }];
		const forgedFingerprint: WorkspaceFingerprint = {
			kind: "artifact-set",
			scope: forgedScope,
			artifacts: forgedArtifacts,
			manifestSha256: computeWorkspaceManifestSha256(forgedScope, forgedArtifacts),
		};
		const executor = createExecutor("provenance-receipt");
		const forgedOutcome = {
			status: "passed",
			exitCode: 0,
			alreadyRedactedOutput: {
				redactionPolicyId: "test-policy-v1",
				stdout: Buffer.from("ok\n"),
				stderr: Buffer.alloc(0),
			},
			receiptId: "forged-receipt",
			goalId: "forged-goal",
			laneId: "forged-lane",
			claim: "forged claim",
			command: { kind: "argv", executable: "forged", argv: [] },
			cwd: "/forged",
			timeoutMs: 1,
			startedAt: "1999-01-01T00:00:00.000Z",
			finishedAt: "1999-01-01T00:00:00.001Z",
			durationMs: 1,
			workspaceBefore: forgedFingerprint,
			workspaceAfter: forgedFingerprint,
			executor: "ci-runner",
			toolCallId: "forged-tool-call",
		} as unknown as VerifiedEvidenceExecutionOutcome;

		// When: the executor records the execution.
		const result = await executor.execute(request(async () => forgedOutcome));

		// Then: only the disposition and redacted output come from the callback.
		expect(result.receipt.core).toMatchObject({
			receiptId: "provenance-receipt",
			goalId: "goal-1",
			laneId: "lane-1",
			claim: "focused verification passed",
			command: { kind: "argv", executable: "node", argv: ["--run", "focused-test"] },
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			startedAt: "2026-07-17T00:00:00.000Z",
			finishedAt: "2026-07-17T00:00:01.250Z",
			durationMs: 1_250,
			executor: "internal",
			toolCallId: "tool-call-1",
			status: "passed",
			exitCode: 0,
		});
		expect(result.receipt.core.workspaceBefore.scope.root).toBe(workspaceRoot);
		expect(result.receipt.core.workspaceAfter.scope.root).toBe(workspaceRoot);
	});

	it("rejects a self-contradictory callback disposition without recording evidence", async () => {
		// Given: a callback that claims a passed status with a failing exit code.
		const executor = createExecutor("contradictory-disposition");
		const contradictory = {
			status: "passed",
			exitCode: 7,
			alreadyRedactedOutput: {
				redactionPolicyId: "test-policy-v1",
				stdout: Buffer.alloc(0),
				stderr: Buffer.alloc(0),
			},
		} as unknown as VerifiedEvidenceExecutionOutcome;

		// When/Then: the executor fails closed on the invalid disposition.
		await expect(executor.execute(request(async () => contradictory))).rejects.toThrow(/disposition/);
		expect(new ReplayLedgerManager("goal-1", ledgerPath).getEvents()).toHaveLength(0);
	});

	it("captures git workspace fingerprints around the verification callback", async () => {
		// Given: the workspace root is a real git repository with a committed baseline.
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: workspaceRoot,
				encoding: "utf8",
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
			});
		git("init", "--quiet", "-b", "main");
		git("config", "user.email", "evidence@omk.test");
		git("config", "user.name", "OMK Evidence");
		git("config", "commit.gpgsign", "false");
		writeFileSync(join(workspaceRoot, "base.txt"), "base\n");
		git("add", ".");
		git("commit", "--quiet", "-m", "baseline");
		const executor = createExecutor("git-workspace-receipt");

		// When: the callback creates a relevant untracked artifact.
		const result = await executor.execute(
			request(async () => {
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
			}),
		);

		// Then: both fingerprints use the git kind for the same scope, and the mutation is committed.
		const before = result.receipt.core.workspaceBefore;
		const after = result.receipt.core.workspaceAfter;
		if (before.kind !== "git" || after.kind !== "git") {
			throw new Error(`expected git fingerprints, got ${before.kind}/${after.kind}`);
		}
		expect(before.git.headCommit).toBe(after.git.headCommit);
		expect(before.git.changedPaths).toEqual([]);
		expect(after.git.changedPaths).toEqual(["dist/result.txt"]);
		expect(after.artifacts[0]).toMatchObject({ path: "dist/result.txt", state: "file" });
		expect(after.manifestSha256).not.toBe(before.manifestSha256);
	});

	it("persists the ledger event before a failed receipt publication", async () => {
		// Given: receipt publication fails at the final pre-link boundary.
		let publicationFailurePending = true;
		const store = new EvidenceReceiptStore(receiptRoot, {
			faultInjector(stage) {
				if (stage === "before-link" && publicationFailurePending) {
					publicationFailurePending = false;
					throw new Error("synthetic receipt publication failure");
				}
			},
		});
		const executor = createExecutor("dangling-receipt", store);

		// When/Then: execution rejects instead of claiming a stored receipt.
		await expect(
			executor.execute(
				request(async () => ({
					status: "passed",
					exitCode: 0,
					alreadyRedactedOutput: {
						redactionPolicyId: "test-policy-v1",
						stdout: Buffer.alloc(0),
						stderr: Buffer.alloc(0),
					},
				})),
			),
		).rejects.toThrow("synthetic receipt publication failure");

		// Then: the persisted event is diagnosable while the missing receipt fails closed.
		expect(new ReplayLedgerManager("goal-1", ledgerPath).getEvents()).toHaveLength(1);
		expect(() => store.read("dangling-receipt")).toThrow();

		const retry = createExecutor("dangling-receipt", store);
		const retried = await retry.execute(
			request(async () => ({
				status: "passed",
				exitCode: 0,
				alreadyRedactedOutput: {
					redactionPolicyId: "test-policy-v1",
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
				},
			})),
		);
		expect(store.read("dangling-receipt")).toEqual(retried.receipt);
	});
});
