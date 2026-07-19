import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVerifiedCiCommand } from "../src/commands/verify-ci.ts";
import { redactSensitiveText } from "../src/core/redaction.ts";
import {
	EvidenceGate,
	EvidenceReceiptStore,
	executeVerifiedLocalBash,
	getShellConfig,
	ReplayLedgerManager,
	TaskContractBuilder,
	VerifiedEvidenceExecutor,
} from "../src/index.ts";

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("verified local bash callsite", () => {
	let root: string;
	let workspaceRoot: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-verified-local-bash-"));
		workspaceRoot = join(root, "workspace");
		mkdirSync(workspaceRoot);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("binds a real built-in local shell execution to a fresh strict receipt", async () => {
		// Given: an isolated receipt store, ledger, workspace, and secret-free script that emits secret-shaped output.
		const goalId = "goal-local-bash";
		const claim = "local verification passed";
		const executor = new VerifiedEvidenceExecutor({
			store: new EvidenceReceiptStore(join(root, "receipts")),
			ledger: new ReplayLedgerManager(goalId, join(root, "ledger", "events.jsonl")),
		});
		const script =
			"mkdir -p dist && printf 'verified\\n' > dist/result.txt && printf '%s=%s\\n%s\\n' token super-secret-value done";

		// When: the first-party local adapter invokes OMK's real local BashOperations backend.
		const result = await executeVerifiedLocalBash({
			evidenceExecutor: executor,
			goalId,
			laneId: "lane-local-bash",
			claim,
			script,
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			workspaceScope: { root: workspaceRoot, artifactPaths: ["dist/result.txt"] },
		});

		// Then: the exact descriptor, artifact, redacted digest, replay binding, and strict gate agree.
		expect(result.receipt.core.command).toEqual({ kind: "shell", shell: getShellConfig().shell, script });
		expect(readFileSync(join(workspaceRoot, "dist", "result.txt"), "utf8")).toBe("verified\n");
		const redacted = Buffer.from(redactSensitiveText("token=super-secret-value\ndone\n"));
		expect(result.receipt.core.output.stdout).toEqual({ sha256: sha256(redacted), byteCount: redacted.byteLength });
		expect(result.receipt.envelope.ledgerBinding?.seq).toBe(1);

		const contract = new TaskContractBuilder(goalId)
			.setClaim(claim)
			.addRequiredEvidence({
				claim,
				category: "release",
				receiptId: result.evidenceMetadata.receiptId,
				receiptSchemaVersion: 3,
				receiptCommandSha256: result.evidenceMetadata.receiptCommandSha256,
				receiptLaneId: result.evidenceMetadata.receiptLaneId,
			})
			.updateEvidenceStatus(claim, "satisfied")
			.setVerdict("pass")
			.build();
		expect(new EvidenceGate({ receiptMode: "strict", ...executor.createGateOptions() }).check(contract).status).toBe(
			"open",
		);
	});

	it("runs a CI command through the local adapter and emits an open strict report", async () => {
		// Given: a CI verification command that creates its selected artifact.
		const script = "mkdir -p dist && printf 'ci-verified\\n' > dist/ci-result.txt";
		const evidenceDir = join(root, "ci-evidence");

		// When: the first-party CI runner executes the command.
		const result = await runVerifiedCiCommand({
			evidenceDir,
			goalId: "goal-ci-pass",
			claim: "CI verification passed",
			script,
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			workspaceScope: { root: workspaceRoot, artifactPaths: ["dist/ci-result.txt"] },
		});

		// Then: the CI executor receipt opens the gate and the report is persisted.
		expect(result.exitCode).toBe(0);
		expect(result.gate.status).toBe("open");
		expect(result.receipt.core).toMatchObject({ executor: "ci-runner", status: "passed", exitCode: 0 });
		expect(existsSync(result.reportPath)).toBe(true);
		expect(readFileSync(result.reportPath, "utf8")).toContain("| evidence-gate | open |");
	});

	it("persists no command secret in the CI receipt, contract report, or ledger", async () => {
		// Given: a CI verification command carrying env, API-header, and URL-query canaries.
		const secrets = {
			environment: "synthetic-ci-env-canary",
			header: "synthetic ci header canary",
			headerEscaped: "synthetic-ci-escaped-header-canary",
			headerConcatenated: "synthetic-ci-concatenated-header-canary",
			query: "synthetic-ci-query-canary",
			queryEscaped: "synthetic-ci-escaped-query-canary",
			queryConcatenated: "synthetic-ci-concatenated-query-canary",
			queryEncoded: "synthetic-ci-encoded-query-canary",
			github: `github_pat_${"C".repeat(24)}`,
			google: `AIza${"D".repeat(35)}`,
		};
		const script =
			`API_TOKEN=${secrets.environment} printf 'x' >/dev/null; ` +
			`printf '%s' 'X-API-Key: ${secrets.header}' >/dev/null; ` +
			`printf '%s' X-API-Key\\:${secrets.headerEscaped} >/dev/null; ` +
			`printf '%s' 'X-API-Key':${secrets.headerConcatenated} >/dev/null; ` +
			`printf '%s' 'https://example.test/run?client_secret=${secrets.query}&region=us' >/dev/null; ` +
			`printf '%s' ?api_key\\=${secrets.queryEscaped} >/dev/null; ` +
			`printf '%s' '?api_key'=${secrets.queryConcatenated} >/dev/null; ` +
			`printf '%s' '?api%5Fkey=${secrets.queryEncoded}' >/dev/null; ` +
			`printf '%s' ${secrets.github} >/dev/null; printf '%s' ${secrets.google} >/dev/null; ` +
			"mkdir -p dist && printf 'ci-verified\\n' > dist/ci-result.txt";
		const evidenceDir = join(root, "ci-secret-evidence");

		// When: the first-party CI runner executes the secret-bearing command.
		const result = await runVerifiedCiCommand({
			evidenceDir,
			goalId: "goal-ci-secret",
			claim: "CI verification passed",
			script,
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			workspaceScope: { root: workspaceRoot, artifactPaths: ["dist/ci-result.txt"] },
		});

		// Then: the command executed with the original script and the strict gate opens.
		expect(result.exitCode).toBe(0);
		expect(result.gate.status).toBe("open");
		expect(readFileSync(join(workspaceRoot, "dist", "ci-result.txt"), "utf8")).toBe("ci-verified\n");

		// Then: only typed placeholders and the keyed binding are serialized anywhere.
		expect(result.receipt.core.command).toMatchObject({ kind: "shell" });
		const persistedScript = (result.receipt.core.command as { script: string }).script;
		expect(persistedScript).toContain("X-API-Key\\:[REDACTED]");
		expect(persistedScript).toContain("'X-API-Key':[REDACTED]");
		expect(persistedScript).toContain("?api_key\\=[REDACTED]");
		expect(persistedScript).toContain("'?api_key'=[REDACTED]");
		expect(persistedScript).toContain("?api%5Fkey=[REDACTED]");
		expect(result.receipt.core.commandRedaction?.placeholders).toEqual([
			{ type: "api-key-header", count: 3 },
			{ type: "env-assignment", count: 1 },
			{ type: "known-token", count: 2 },
			{ type: "url-query", count: 4 },
		]);
		expect(result.receipt.core.commandBinding?.algorithm).toBe("hmac-sha256");
		const forbidden = [
			...Object.values(secrets),
			...Object.values(secrets).map((value) => createHash("sha256").update(value).digest("hex")),
			createHash("sha256").update(script).digest("hex"),
			createHash("sha256")
				.update(JSON.stringify({ kind: "shell", shell: getShellConfig().shell, script }))
				.digest("hex"),
		];
		for (const artifact of [result.receiptPath, result.reportPath, join(evidenceDir, "ledger", "events.jsonl")]) {
			const persisted = readFileSync(artifact, "utf8");
			for (const value of forbidden) expect(persisted).not.toContain(value);
		}
		expect(readFileSync(result.reportPath, "utf8")).toContain("client_secret=[REDACTED]");
	});

	it("binds git workspace fingerprints for a CI run inside a git repository", async () => {
		// Given: the CI workspace root is a real git repository with a committed baseline.
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

		// When: the first-party CI runner executes inside the repository.
		const result = await runVerifiedCiCommand({
			evidenceDir: join(root, "ci-git-evidence"),
			goalId: "goal-ci-git",
			claim: "CI verification passed",
			script: "mkdir -p dist && printf 'ci-verified\\n' > dist/ci-result.txt",
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			workspaceScope: { root: workspaceRoot, artifactPaths: ["dist/ci-result.txt"] },
		});

		// Then: the receipt carries git-kind fingerprints and the strict gate opens.
		expect(result.exitCode).toBe(0);
		expect(result.gate.status).toBe("open");
		expect(result.receipt.core.workspaceBefore.kind).toBe("git");
		expect(result.receipt.core.workspaceAfter.kind).toBe("git");
		const after = result.receipt.core.workspaceAfter;
		if (after.kind !== "git") throw new Error("expected a git fingerprint");
		expect(after.git.changedPaths).toEqual(["dist/ci-result.txt"]);
		expect(after.artifacts[0]).toMatchObject({ path: "dist/ci-result.txt", state: "file" });
	});

	it("wires CI receipt freshness to its replay ledger workspace-mutation source", async () => {
		// Given: the goal ledger already contains a relevant workspace mutation at seq 1.
		const evidenceDir = join(root, "ci-mutation-evidence");
		const seeded = new ReplayLedgerManager("goal-ci-mutation", join(evidenceDir, "ledger", "events.jsonl"));
		seeded.append({
			type: "workspace_mutation",
			goalId: "goal-ci-mutation",
			payload: { root: workspaceRoot, paths: ["dist/ci-result.txt"] },
		});
		seeded.persist();

		// When: the CI runner executes after the recorded mutation.
		const result = await runVerifiedCiCommand({
			evidenceDir,
			goalId: "goal-ci-mutation",
			claim: "CI verification passed",
			script: "mkdir -p dist && printf 'ci-verified\\n' > dist/ci-result.txt",
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			workspaceScope: { root: workspaceRoot, artifactPaths: ["dist/ci-result.txt"] },
		});

		// Then: the receipt post-dates the mutation through the wired ledger source and stays open.
		expect(result.receipt.envelope.ledgerBinding?.seq).toBe(2);
		expect(result.exitCode).toBe(0);
		expect(result.gate.status).toBe("open");
	});

	it("returns a blocked CI result for a failed command receipt", async () => {
		// Given: a CI verification command that exits non-zero.
		const evidenceDir = join(root, "ci-failed-evidence");

		// When: the first-party CI runner records the failure.
		const result = await runVerifiedCiCommand({
			evidenceDir,
			goalId: "goal-ci-failed",
			claim: "CI verification passed",
			script: "exit 7",
			cwd: workspaceRoot,
			timeoutMs: 30_000,
			workspaceScope: { root: workspaceRoot, artifactPaths: ["dist/ci-result.txt"] },
		});

		// Then: the receipt remains failed and the strict gate controls the process exit.
		expect(result.exitCode).toBe(1);
		expect(result.gate.status).toBe("blocked");
		expect(result.receipt.core).toMatchObject({ executor: "ci-runner", status: "failed", exitCode: 7 });
	});

	it("wires the compiled verified CI entry into the repository workflow", () => {
		// Given: the shipped GitHub Actions workflow.
		const workflow = readFileSync(join(import.meta.dirname, "../../../.github/workflows/ci.yml"), "utf8");

		// When/Then: CI invokes the compiled first-party receipt entry and retains its artifacts.
		expect(workflow).toContain("node packages/coding-agent/dist/verify-ci.js");
		expect(workflow).toContain("id: verify_receipt");
		expect(workflow).toContain("if: always() && steps.verify_receipt.outcome != 'skipped'");
		expect(workflow).toContain(".omk/ci-evidence");
	});
});
