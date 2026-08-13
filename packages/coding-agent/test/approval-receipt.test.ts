import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createApprovalReceipt,
	parseApprovalReceipt,
	validateApprovalReceipt,
} from "../src/approvals/approval-receipt.ts";
import { ApprovalReceiptStore } from "../src/approvals/approval-receipt-store.ts";
import { verifyApprovalForExecution } from "../src/approvals/approval-verifier.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omk-approval-receipt-"));
	roots.push(root);
	return root;
}

function receipt(
	feedback = "Use the existing parser; token sk-proj-secret-value-1234567890",
	decision: "approved" | "rejected" = "approved",
) {
	return createApprovalReceipt({
		provider: "plannotator",
		requestId: "request-1",
		reviewId: "review-1",
		decision,
		decidedAt: "2026-08-04T00:00:00.000Z",
		sessionId: "session-1",
		planPath: "plans/auth.md",
		planContent: "# Auth plan\n\n- [ ] Add validation\n",
		feedback,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("approval receipts", () => {
	it("binds the decision to request, review, session, plan bytes, and feedback digest", () => {
		const created = receipt();

		expect(created.core).toMatchObject({
			provider: "plannotator",
			requestId: "request-1",
			reviewId: "review-1",
			decision: "approved",
			sessionId: "session-1",
			plan: { path: "plans/auth.md", bytes: 34 },
		});
		expect(created.core.plan.sha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(created.core.feedback?.sha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(JSON.stringify(created)).not.toContain("sk-proj-secret-value");
		expect(validateApprovalReceipt(structuredClone(created))).toEqual(created);
	});

	it("rejects tampered immutable core data", () => {
		const tampered = structuredClone(receipt()) as unknown as { core: { decision: string }; coreSha256: string };
		tampered.core.decision = "rejected";

		expect(() => validateApprovalReceipt(tampered)).toThrow(/digest mismatch/u);
	});

	it("rejects plan paths outside the workspace", () => {
		expect(() =>
			createApprovalReceipt({
				provider: "plannotator",
				requestId: "request-2",
				reviewId: "review-2",
				decision: "rejected",
				decidedAt: "2026-08-04T00:00:00.000Z",
				sessionId: "session-1",
				planPath: "../outside.md",
				planContent: "no",
			}),
		).toThrow(/workspace-relative/u);
	});

	it("requires an approved receipt to match current session, path, and plan bytes", () => {
		const created = receipt("");
		const binding = {
			sessionId: "session-1",
			planPath: "plans/auth.md",
			planContent: "# Auth plan\n\n- [ ] Add validation\n",
		};

		expect(verifyApprovalForExecution(created, binding).valid).toBe(true);
		expect(verifyApprovalForExecution(created, { ...binding, planContent: `${binding.planContent}changed` })).toEqual(
			{
				valid: false,
				reason: "plan-content-mismatch",
			},
		);
		expect(verifyApprovalForExecution(receipt("", "rejected"), binding)).toEqual({
			valid: false,
			reason: "not-approved",
		});
	});

	it("persists once with owner-only modes and permits only identical idempotent writes", () => {
		const root = tempRoot();
		const store = new ApprovalReceiptStore(join(root, "receipts"));
		const created = receipt("");

		const first = store.write(created);
		const second = store.write(created);
		const mode = lstatSync(first.path).mode & 0o777;

		expect(first.created).toBe(true);
		expect(second).toEqual({ path: first.path, created: false });
		expect(mode).toBe(0o600);
		expect(store.read(created.core.receiptId)).toEqual(created);
	});

	it("never overwrites a conflicting receipt id", () => {
		const root = tempRoot();
		const store = new ApprovalReceiptStore(join(root, "receipts"));
		const original = receipt("");
		const conflicting = receipt("", "rejected");
		const path = store.write(original).path;
		const before = readFileSync(path, "utf8");

		expect(conflicting.core.receiptId).toBe(original.core.receiptId);
		expect(() => store.write(conflicting)).toThrow(/never overwritten/u);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(parseApprovalReceipt(before)).toEqual(original);
	});

	it("rejects insecure receipt-root permissions", () => {
		const root = tempRoot();
		const receiptsDir = join(root, "receipts");
		mkdirSync(receiptsDir, { mode: 0o700 });
		chmodSync(receiptsDir, 0o755);

		expect(() => new ApprovalReceiptStore(receiptsDir)).toThrow(/permissions must be 0700/u);
	});

	it("rejects symlinked receipt roots and receipt files", () => {
		if (process.platform === "win32") return;
		const root = tempRoot();
		const targetDir = join(root, "target");
		const linkedDir = join(root, "linked-receipts");
		mkdirSync(targetDir, { mode: 0o700 });
		symlinkSync(targetDir, linkedDir, "dir");
		expect(() => new ApprovalReceiptStore(linkedDir)).toThrow(/real directory/u);

		const receiptsDir = join(root, "receipts");
		const store = new ApprovalReceiptStore(receiptsDir);
		const created = receipt("");
		const targetFile = join(root, "target.json");
		writeFileSync(targetFile, "{}", { mode: 0o600 });
		symlinkSync(targetFile, join(receiptsDir, `${created.core.receiptId}.json`));

		expect(() => store.write(created)).toThrow(/ELOOP|symbolic links?/iu);
	});

	it("rejects hard-linked or non-private receipt files", () => {
		const hardLinkRoot = tempRoot();
		const hardLinkStore = new ApprovalReceiptStore(join(hardLinkRoot, "receipts"));
		const hardLinked = receipt("");
		const hardLinkedPath = hardLinkStore.write(hardLinked).path;
		linkSync(hardLinkedPath, join(hardLinkRoot, "receipt-alias.json"));
		expect(() => hardLinkStore.read(hardLinked.core.receiptId)).toThrow(/hard-linked/u);

		const modeRoot = tempRoot();
		const modeStore = new ApprovalReceiptStore(join(modeRoot, "receipts"));
		const nonPrivate = receipt("");
		const nonPrivatePath = modeStore.write(nonPrivate).path;
		chmodSync(nonPrivatePath, 0o644);
		expect(() => modeStore.read(nonPrivate.core.receiptId)).toThrow(/permissions must be 0600/u);
	});
});
