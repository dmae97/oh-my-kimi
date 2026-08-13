import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalReceiptStore } from "../src/approvals/approval-receipt-store.ts";
import {
	type ApprovalEventBus,
	PLANNOTATOR_REQUEST_CHANNEL,
	PLANNOTATOR_REVIEW_RESULT_CHANNEL,
	PlannotatorApprovalBridge,
} from "../src/index.ts";

class FakeEventBus implements ApprovalEventBus {
	readonly emitted: Array<{ channel: string; data: unknown }> = [];
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	response: unknown = { status: "handled", result: { status: "pending", reviewId: "review-1" } };

	emit(channel: string, data: unknown): void {
		this.emitted.push({ channel, data });
		if (channel === PLANNOTATOR_REQUEST_CHANNEL && typeof data === "object" && data !== null && "respond" in data) {
			(data as { respond: (response: unknown) => void }).respond(this.response);
		}
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omk-plannotator-bridge-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function createBridge(bus: FakeEventBus, onReceipt?: (receiptId: string) => void): PlannotatorApprovalBridge {
	return new PlannotatorApprovalBridge({
		eventBus: bus,
		store: new ApprovalReceiptStore(join(root, "receipts")),
		workspaceRoot: root,
		sessionId: "session-1",
		interactive: true,
		requestIdFactory: () => "request-1",
		clock: () => new Date("2026-08-04T00:00:00.000Z"),
		onReceipt: (receipt) => onReceipt?.(receipt.core.receiptId),
	});
}

describe("Plannotator approval bridge", () => {
	it("requests a correlated asynchronous plan review without importing Plannotator", async () => {
		const bus = new FakeEventBus();
		const bridge = createBridge(bus);
		bridge.start();

		const request = await bridge.requestReview({ planPath: "plans/auth.md", planContent: "# Plan\n" });
		const emitted = bus.emitted[0];

		expect(request).toEqual({ requestId: "request-1", reviewId: "review-1" });
		expect(emitted.channel).toBe(PLANNOTATOR_REQUEST_CHANNEL);
		expect(emitted.data).toMatchObject({
			requestId: "request-1",
			action: "plan-review",
			payload: { planContent: "# Plan\n", planFilePath: "plans/auth.md" },
		});
	});

	it("persists an approved event exactly once and never dispatches execution", async () => {
		const bus = new FakeEventBus();
		const receiptIds: string[] = [];
		const bridge = createBridge(bus, (receiptId) => receiptIds.push(receiptId));
		bridge.start();
		await bridge.requestReview({ planPath: "plans/auth.md", planContent: "# Plan\n" });

		const first = await bridge.handleReviewResult({ reviewId: "review-1", approved: true, feedback: "Ship it" });
		const duplicate = await bridge.handleReviewResult({ reviewId: "review-1", approved: true });

		expect(first.status).toBe("persisted");
		if (first.status !== "persisted") throw new Error("Expected persisted receipt");
		expect(first.receipt.core).toMatchObject({
			requestId: "request-1",
			reviewId: "review-1",
			decision: "approved",
			sessionId: "session-1",
			plan: { path: "plans/auth.md" },
		});
		expect(JSON.stringify(first.receipt)).not.toContain("Ship it");
		expect(duplicate).toEqual({ status: "ignored", reason: "unknown-review" });
		expect(receiptIds).toEqual([first.receipt.core.receiptId]);
	});

	it("records rejections as immutable decisions", async () => {
		const bus = new FakeEventBus();
		const bridge = createBridge(bus);
		bridge.start();
		await bridge.requestReview({ planPath: "plans/auth.md", planContent: "# Plan\n" });

		const result = await bridge.handleReviewResult({ reviewId: "review-1", approved: false, feedback: "Revise" });

		expect(result.status).toBe("persisted");
		if (result.status === "persisted") expect(result.receipt.core.decision).toBe("rejected");
	});

	it("fails closed without interactive UI or an active subscription", async () => {
		const bus = new FakeEventBus();
		const bridge = new PlannotatorApprovalBridge({
			eventBus: bus,
			store: new ApprovalReceiptStore(join(root, "receipts")),
			workspaceRoot: root,
			sessionId: "session-1",
			interactive: false,
		});

		await expect(bridge.requestReview({ planPath: "plan.md", planContent: "plan" })).rejects.toThrow(/interactive/u);
		expect(bus.emitted).toHaveLength(0);
	});

	it("rejects uncorrelated, malformed, and workspace-escaping inputs", async () => {
		const bus = new FakeEventBus();
		const bridge = createBridge(bus);
		bridge.start();

		await expect(bridge.requestReview({ planPath: "../outside.md", planContent: "plan" })).rejects.toThrow(
			/workspace/u,
		);
		await expect(bridge.handleReviewResult({ reviewId: "unknown", approved: true })).resolves.toEqual({
			status: "ignored",
			reason: "unknown-review",
		});
		await expect(bridge.handleReviewResult({ reviewId: "review-1", approved: "yes" })).resolves.toEqual({
			status: "ignored",
			reason: "invalid-event",
		});
	});

	it("receives review-result events through the shared channel", async () => {
		const bus = new FakeEventBus();
		const receiptIds: string[] = [];
		const bridge = createBridge(bus, (receiptId) => receiptIds.push(receiptId));
		bridge.start();
		await bridge.requestReview({ planPath: "plan.md", planContent: "plan" });

		bus.emit(PLANNOTATOR_REVIEW_RESULT_CHANNEL, { reviewId: "review-1", approved: true });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(receiptIds).toHaveLength(1);
	});
});
