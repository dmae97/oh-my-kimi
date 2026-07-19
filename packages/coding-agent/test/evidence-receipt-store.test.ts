import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEvidenceReceipt, parseSha256Hex } from "../src/guardrails/evidence-receipt.ts";
import { EvidenceReceiptStore, type EvidenceReceiptStoreFaultStage } from "../src/guardrails/evidence-receipt-store.ts";
import { computeWorkspaceManifestSha256 } from "../src/guardrails/workspace-fingerprint.ts";
import type { ArtifactState, EvidenceReceipt, WorkspaceFingerprint, WorkspaceScope } from "../src/types/evidence.ts";

let tempRoot: string;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "omk-evidence-receipt-store-"));
});

afterEach(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

function sha256(value: string) {
	return parseSha256Hex(createHash("sha256").update(value).digest("hex"));
}

function fingerprint(): WorkspaceFingerprint {
	const scope: WorkspaceScope = { root: "/workspace", artifactPaths: ["result.txt"] };
	const artifacts: ArtifactState[] = [{ path: "result.txt", state: "file", sha256: sha256("result"), size: 6 }];
	return {
		kind: "artifact-set",
		scope,
		artifacts,
		manifestSha256: computeWorkspaceManifestSha256(scope, artifacts),
	};
}

function makeReceipt(receiptId = "store-receipt-001", output = "redacted output"): EvidenceReceipt {
	return createEvidenceReceipt({
		receiptId,
		goalId: "goal-store",
		claim: "store durability",
		command: { kind: "argv", executable: "node", argv: ["--run", "focused-test"] },
		cwd: "/workspace",
		timeoutMs: 10_000,
		startedAt: "2026-07-15T11:00:00.000Z",
		finishedAt: "2026-07-15T11:00:00.500Z",
		durationMs: 500,
		status: "passed",
		exitCode: 0,
		workspaceBefore: fingerprint(),
		workspaceAfter: fingerprint(),
		alreadyRedactedOutput: {
			redactionPolicyId: "policy-v1",
			stdout: Buffer.from(output),
			stderr: Buffer.alloc(0),
		},
		executor: "internal",
	});
}

function allEntries(root: string): string[] {
	if (!statSync(root).isDirectory()) return [];
	return readdirSync(root, { recursive: true, encoding: "utf8" }).map(String);
}

function symlinkOrSkip(target: string, path: string): boolean {
	try {
		symlinkSync(target, path, "dir");
		return true;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
		if (["EACCES", "ENOSYS", "EPERM"].includes(code)) return false;
		throw error;
	}
}

describe("EvidenceReceiptStore", () => {
	it("writes owner-only and reads through the strict parser", () => {
		const store = new EvidenceReceiptStore(join(tempRoot, "receipts"));
		const receipt = makeReceipt();
		const path = store.write(receipt);
		const loaded = store.read(receipt.core.receiptId);

		expect(loaded).toEqual(receipt);
		expect(path).toBe(store.getReceiptPath(receipt.core.receiptId));
		if (process.platform !== "win32") {
			expect(statSync(store.getRoot()).mode & 0o777).toBe(0o700);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		expect(allEntries(store.getRoot()).some((entry) => entry.includes(".tmp"))).toBe(false);
	});

	it("fsyncs a new root's parent without changing existing-root construction", () => {
		const root = join(tempRoot, "constructor-durability");
		let newRootParentFsyncAttempted = false;
		new EvidenceReceiptStore(root, {
			faultInjector(stage) {
				if (stage === "before-root-parent-directory-fsync") newRootParentFsyncAttempted = true;
			},
		});
		expect(newRootParentFsyncAttempted).toBe(true);

		let existingRootParentFsyncAttempted = false;
		new EvidenceReceiptStore(root, {
			faultInjector(stage) {
				if (stage === "before-root-parent-directory-fsync") existingRootParentFsyncAttempted = true;
			},
		});
		expect(existingRootParentFsyncAttempted).toBe(false);
	});

	it("fails explicitly when new-root parent durability is unsupported", () => {
		const unsupported = Object.assign(new Error("synthetic directory fsync failure"), { code: "EINVAL" });
		expect(
			() =>
				new EvidenceReceiptStore(join(tempRoot, "unsupported-constructor-durability"), {
					faultInjector(stage) {
						if (stage === "before-root-parent-directory-fsync") throw unsupported;
					},
				}),
		).toThrow(/strict durability unavailable.*directory fsync unsupported.*EINVAL/);
	});

	it("does not bypass a failed new-root parent fsync on constructor retry", () => {
		const root = join(tempRoot, "retry-constructor-durability");
		let parentFsyncAttempts = 0;
		const construct = () =>
			new EvidenceReceiptStore(root, {
				faultInjector(stage) {
					if (stage !== "before-root-parent-directory-fsync") return;
					parentFsyncAttempts++;
					if (parentFsyncAttempts === 1) throw new Error("synthetic parent fsync failure");
				},
			});

		expect(construct).toThrow("synthetic parent fsync failure");
		expect(existsSync(root)).toBe(false);
		expect(construct).not.toThrow();
		expect(parentFsyncAttempts).toBe(2);
	});

	it("cleans every directory created for a recursive multi-ancestor root after durability failure", () => {
		const firstAncestor = join(tempRoot, "recursive");
		const secondAncestor = join(firstAncestor, "ancestors");
		const root = join(secondAncestor, "receipts");
		let parentFsyncAttempted = false;

		expect(
			() =>
				new EvidenceReceiptStore(root, {
					faultInjector(stage) {
						if (stage !== "before-root-parent-directory-fsync") return;
						parentFsyncAttempted = true;
						for (const path of [firstAncestor, secondAncestor, root]) {
							expect(statSync(path).isDirectory()).toBe(true);
						}
						throw new Error("synthetic recursive parent fsync failure");
					},
				}),
		).toThrow("synthetic recursive parent fsync failure");
		expect(parentFsyncAttempted).toBe(true);
		for (const path of [root, secondAncestor, firstAncestor]) expect(existsSync(path)).toBe(false);

		const retry = new EvidenceReceiptStore(root);
		expect(retry.getRoot()).toBe(root);
	});

	it("fails closed when rollback parent durability fails and allows a clean retry", () => {
		if (process.platform === "win32") return;
		const firstAncestor = join(tempRoot, "rollback-durability-failure");
		const secondAncestor = join(firstAncestor, "nested");
		const root = join(secondAncestor, "receipts");
		let parentFsyncAttempts = 0;
		const construct = () =>
			new EvidenceReceiptStore(root, {
				faultInjector(stage) {
					if (stage !== "before-root-parent-directory-fsync") return;
					parentFsyncAttempts++;
					if (parentFsyncAttempts !== 1) return;
					chmodSync(secondAncestor, 0o300);
					throw new Error("synthetic constructor durability failure");
				},
			});

		expect(construct).toThrow(/cleanup was incomplete.*synthetic constructor durability failure/);
		for (const path of [root, secondAncestor, firstAncestor]) expect(existsSync(path)).toBe(false);
		expect(construct).not.toThrow();
		expect(parentFsyncAttempts).toBe(2);
	});

	it("never overwrites an existing receipt id", () => {
		const store = new EvidenceReceiptStore(join(tempRoot, "receipts"));
		const first = makeReceipt("same-id", "first output");
		const second = makeReceipt("same-id", "second output");
		store.write(first);
		expect(() => store.write(second)).toThrow();
		expect(store.read("same-id").envelope.coreSha256).toBe(first.envelope.coreSha256);
	});

	it("rejects an overlapping write without overwriting the winner", () => {
		const root = join(tempRoot, "overlapping");
		const challenger = new EvidenceReceiptStore(root);
		const first = makeReceipt("overlapping-id", "first output");
		const second = makeReceipt("overlapping-id", "second output");
		let challengerFailed = false;
		const winner = new EvidenceReceiptStore(root, {
			faultInjector(stage) {
				if (stage !== "after-receipt-directory") return;
				try {
					challenger.write(second);
				} catch {
					challengerFailed = true;
				}
			},
		});

		winner.write(first);
		expect(challengerFailed).toBe(true);
		expect(winner.read(first.core.receiptId).envelope.coreSha256).toBe(first.envelope.coreSha256);
	});

	it("uses no-overwrite publication even when the destination appears immediately before link", () => {
		const root = join(tempRoot, "publish-race");
		const receipt = makeReceipt("publish-race-id");
		const sentinel = "pre-existing destination\n";
		const store = new EvidenceReceiptStore(root, {
			faultInjector(stage) {
				if (stage === "before-link") writeFileSync(store.getReceiptPath(receipt.core.receiptId), sentinel);
			},
		});

		expect(() => store.write(receipt)).toThrow(/no-overwrite publish failed/);
		expect(readFileSync(store.getReceiptPath(receipt.core.receiptId), "utf8")).toBe(sentinel);
	});

	it("rejects traversal and absolute storage ids", () => {
		const store = new EvidenceReceiptStore(join(tempRoot, "receipts"));
		for (const id of ["../escape", "/absolute", "a/b", ".", ".."]) expect(() => store.read(id)).toThrow(/not safe/);
	});

	it("rejects malformed stored receipts", () => {
		const store = new EvidenceReceiptStore(join(tempRoot, "receipts"));
		const path = store.getReceiptPath("malformed-receipt");
		mkdirSync(dirname(path), { mode: 0o700 });
		writeFileSync(path, '{"core":{},"envelope":{}}\n', { mode: 0o600 });
		expect(() => store.read("malformed-receipt")).toThrow(/receipt core.*invalid key set/);
	});

	it("rejects deterministic receipt-directory and root replacement", () => {
		const directoryRoot = join(tempRoot, "directory-replacement");
		const receiptId = "directory-replacement-id";
		const outside = join(tempRoot, "outside-directory");
		const probe = join(tempRoot, "symlink-probe");
		mkdirSync(outside);
		if (!symlinkOrSkip(outside, probe)) return;
		rmSync(probe);
		const receiptDirectory = join(directoryRoot, receiptId);
		const displacedDirectory = join(tempRoot, "displaced-receipt-directory");
		const directoryStore = new EvidenceReceiptStore(directoryRoot, {
			faultInjector(stage) {
				if (stage !== "after-receipt-directory") return;
				renameSync(receiptDirectory, displacedDirectory);
				symlinkSync(outside, receiptDirectory, "dir");
			},
		});
		expect(() => directoryStore.write(makeReceipt(receiptId))).toThrow(/receipt directory/);
		expect(readdirSync(outside)).toEqual([]);

		const rootPath = join(tempRoot, "root-replacement");
		const displacedRoot = join(tempRoot, "displaced-root");
		const rootStore = new EvidenceReceiptStore(rootPath, {
			faultInjector(stage) {
				if (stage !== "after-receipt-directory") return;
				renameSync(rootPath, displacedRoot);
				mkdirSync(rootPath, { mode: 0o700 });
			},
		});
		expect(() => rootStore.write(makeReceipt("root-replacement-id"))).toThrow(/root/);
		expect(readdirSync(rootPath)).toEqual([]);
	});

	it("cleans every pre-publish fault without exposing a partial receipt", () => {
		const stages: EvidenceReceiptStoreFaultStage[] = [
			"after-receipt-directory",
			"after-temp-open",
			"after-temp-write",
			"after-temp-fsync",
			"after-temp-close",
			"before-link",
		];
		for (const stage of stages) {
			const root = join(tempRoot, stage);
			const store = new EvidenceReceiptStore(root, {
				faultInjector(current) {
					if (current === stage) throw new Error(`fault:${stage}`);
				},
			});
			expect(() => store.write(makeReceipt(stage))).toThrow(`fault:${stage}`);
			expect(allEntries(root)).toEqual([]);
			expect(() => store.read(stage)).toThrow();

			const retry = new EvidenceReceiptStore(root);
			retry.write(makeReceipt(stage));
			expect(retry.read(stage).core.receiptId).toBe(stage);
		}
	});

	it("fsyncs temp and receipt-directory rollback boundaries before a retry", () => {
		const root = join(tempRoot, "durable-write-rollback");
		const observed: EvidenceReceiptStoreFaultStage[] = [];
		let failBeforePublish = true;
		const store = new EvidenceReceiptStore(root, {
			faultInjector(stage) {
				observed.push(stage);
				if (stage === "before-link" && failBeforePublish) {
					failBeforePublish = false;
					throw new Error("synthetic pre-publication failure");
				}
			},
		});
		const receipt = makeReceipt("durable-write-rollback-id");

		expect(() => store.write(receipt)).toThrow("synthetic pre-publication failure");
		const tempCleanup = observed.indexOf("before-temp-cleanup-directory-fsync");
		const directoryCleanup = observed.indexOf("before-receipt-directory-cleanup-root-fsync");
		expect(tempCleanup).toBeGreaterThan(observed.indexOf("before-link"));
		expect(directoryCleanup).toBeGreaterThan(tempCleanup);
		expect(allEntries(root)).toEqual([]);

		expect(() => store.write(receipt)).not.toThrow();
		expect(store.read(receipt.core.receiptId)).toEqual(receipt);
	});

	it("reports temp and receipt-directory cleanup faults and permits retry", () => {
		const cases: Array<{
			readonly receiptId: string;
			readonly trigger: EvidenceReceiptStoreFaultStage;
			readonly cleanup: EvidenceReceiptStoreFaultStage;
		}> = [
			{
				receiptId: "temp-cleanup-fault",
				trigger: "after-temp-open",
				cleanup: "before-temp-cleanup-directory-fsync",
			},
			{
				receiptId: "directory-cleanup-fault",
				trigger: "after-receipt-directory",
				cleanup: "before-receipt-directory-cleanup-root-fsync",
			},
		];

		for (const testCase of cases) {
			const root = join(tempRoot, testCase.receiptId);
			let writeFaultPending = true;
			let cleanupFaultPending = true;
			const store = new EvidenceReceiptStore(root, {
				faultInjector(stage) {
					if (stage === testCase.trigger && writeFaultPending) {
						writeFaultPending = false;
						throw new Error(`write fault:${testCase.trigger}`);
					}
					if (stage === testCase.cleanup && cleanupFaultPending) {
						cleanupFaultPending = false;
						throw new Error(`cleanup fault:${testCase.cleanup}`);
					}
				},
			});
			const receipt = makeReceipt(testCase.receiptId);

			expect(() => store.write(receipt)).toThrow(
				/cleanup was incomplete: write fault:.*cleanup failure: cleanup fault:/,
			);
			expect(cleanupFaultPending).toBe(false);
			expect(allEntries(root)).toEqual([]);
			expect(() => store.write(receipt)).not.toThrow();
			expect(store.read(receipt.core.receiptId)).toEqual(receipt);
		}
	});

	it("post-publish faults leave only a complete, strictly readable receipt", () => {
		const stages: EvidenceReceiptStoreFaultStage[] = [
			"after-link",
			"after-temp-unlink",
			"after-receipt-directory-fsync",
			"after-root-directory-fsync",
		];
		for (const stage of stages) {
			const root = join(tempRoot, `post-${stage}`);
			const receipt = makeReceipt(`post-${stage}`);
			const store = new EvidenceReceiptStore(root, {
				faultInjector(current) {
					if (current === stage) throw new Error(`fault:${stage}`);
				},
			});
			expect(() => store.write(receipt)).toThrow(`fault:${stage}`);
			const loaded = new EvidenceReceiptStore(root).read(receipt.core.receiptId);
			expect(loaded).toEqual(receipt);
			expect(allEntries(root).some((entry) => entry.includes(".tmp"))).toBe(false);
		}
	});

	it("rejects a symlink store root when symlinks are supported", () => {
		const target = join(tempRoot, "real-store");
		const link = join(tempRoot, "linked-store");
		mkdirSync(target);
		try {
			symlinkSync(target, link, "dir");
		} catch (error) {
			const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
			if (["EACCES", "ENOSYS", "EPERM"].includes(code)) return;
			throw error;
		}
		expect(() => new EvidenceReceiptStore(link)).toThrow(/symlink/);
	});
});
