import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type ApprovalReceipt, createApprovalReceipt } from "./approval-receipt.ts";
import type { ApprovalReceiptStore } from "./approval-receipt-store.ts";

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
export const PLANNOTATOR_REVIEW_RESULT_CHANNEL = "plannotator:review-result";

const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_FEEDBACK_BYTES = 1024 * 1024;
const SAFE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;

export interface ApprovalEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface PlannotatorApprovalBridgeOptions {
	eventBus: ApprovalEventBus;
	store: ApprovalReceiptStore;
	workspaceRoot: string;
	sessionId: string;
	interactive: boolean;
	requestTimeoutMs?: number;
	requestIdFactory?: () => string;
	clock?: () => Date;
	onReceipt?: (receipt: ApprovalReceipt, write: ReturnType<ApprovalReceiptStore["write"]>) => void | Promise<void>;
	onError?: (code: "invalid-event" | "event-handler-failed") => void;
}

export interface PlanReviewRequest {
	planPath: string;
	planContent: string;
}

export interface PlanReviewCorrelation {
	requestId: string;
	reviewId: string;
}

export type ReviewResultOutcome =
	| { status: "persisted"; receipt: ApprovalReceipt; write: ReturnType<ApprovalReceiptStore["write"]> }
	| { status: "ignored"; reason: "invalid-event" | "unknown-review" };

interface PendingReview {
	requestId: string;
	reviewId: string;
	planPath: string;
	planContent: string;
}

interface ParsedReviewResult {
	reviewId: string;
	approved: boolean;
	feedback?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: unknown, label: string): string {
	if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) throw new Error(`${label} is not a safe identifier`);
	return value;
}

function parseReviewResponse(value: unknown): string {
	if (!isRecord(value) || value.status !== "handled" || !isRecord(value.result) || value.result.status !== "pending") {
		throw new Error("Plannotator did not accept the review request");
	}
	return safeId(value.result.reviewId, "reviewId");
}

function parseReviewResult(value: unknown): ParsedReviewResult {
	if (!isRecord(value)) throw new Error("Review result must be an object");
	const allowed = new Set(["reviewId", "approved", "feedback", "savedPath", "agentSwitch", "permissionMode"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error("Review result contained an unsupported field");
	}
	const reviewId = safeId(value.reviewId, "reviewId");
	if (typeof value.approved !== "boolean") throw new Error("Review result approved must be boolean");
	if (value.feedback !== undefined && typeof value.feedback !== "string") {
		throw new Error("Review result feedback must be a string");
	}
	if (typeof value.feedback === "string" && Buffer.byteLength(value.feedback, "utf8") > MAX_FEEDBACK_BYTES) {
		throw new Error("Review result feedback exceeds the size limit");
	}
	return {
		reviewId,
		approved: value.approved,
		...(typeof value.feedback === "string" ? { feedback: value.feedback } : {}),
	};
}

export class PlannotatorApprovalBridge {
	private readonly eventBus: ApprovalEventBus;
	private readonly store: ApprovalReceiptStore;
	private readonly workspaceRoot: string;
	private readonly sessionId: string;
	private readonly interactive: boolean;
	private readonly requestTimeoutMs: number;
	private readonly requestIdFactory: () => string;
	private readonly clock: () => Date;
	private readonly onReceipt?: PlannotatorApprovalBridgeOptions["onReceipt"];
	private readonly onError?: PlannotatorApprovalBridgeOptions["onError"];
	private readonly pending = new Map<string, PendingReview>();
	private unsubscribe?: () => void;

	constructor(options: PlannotatorApprovalBridgeOptions) {
		this.eventBus = options.eventBus;
		this.store = options.store;
		this.workspaceRoot = resolve(options.workspaceRoot);
		this.sessionId = safeId(options.sessionId, "sessionId");
		this.interactive = options.interactive;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
		this.requestIdFactory = options.requestIdFactory ?? (() => `request-${randomUUID()}`);
		this.clock = options.clock ?? (() => new Date());
		this.onReceipt = options.onReceipt;
		this.onError = options.onError;
	}

	start(): void {
		if (this.unsubscribe) return;
		this.unsubscribe = this.eventBus.on(PLANNOTATOR_REVIEW_RESULT_CHANNEL, (data) => {
			void this.handleReviewResult(data).catch(() => this.onError?.("event-handler-failed"));
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.pending.clear();
	}

	private relativePlanPath(planPath: string): string {
		if (!planPath || planPath.includes("\0")) throw new Error("Plan path must be inside the workspace");
		const absolutePath = resolve(this.workspaceRoot, planPath);
		const relativePath = relative(this.workspaceRoot, absolutePath);
		if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new Error("Plan path must be a workspace-relative file");
		}
		return relativePath.split(sep).join("/");
	}

	private requestFromPlannotator(requestId: string, payload: Record<string, string>): Promise<unknown> {
		return new Promise((resolveResponse, rejectResponse) => {
			let settled = false;
			const settle = (callback: (value: unknown) => void, value: unknown): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				callback(value);
			};
			const timeout = setTimeout(
				() => settle(rejectResponse, new Error("Plannotator review request timed out")),
				this.requestTimeoutMs,
			);
			timeout.unref?.();
			try {
				this.eventBus.emit(PLANNOTATOR_REQUEST_CHANNEL, {
					requestId,
					action: "plan-review",
					payload,
					respond: (response: unknown) => settle(resolveResponse, response),
				});
			} catch (error) {
				settle(rejectResponse, error);
			}
		});
	}

	async requestReview(input: PlanReviewRequest): Promise<PlanReviewCorrelation> {
		if (!this.interactive) throw new Error("Plannotator approval requires an interactive UI");
		if (!this.unsubscribe) throw new Error("Plannotator approval bridge is not started");
		if (Buffer.byteLength(input.planContent, "utf8") > MAX_PLAN_BYTES) throw new Error("Plan exceeds the size limit");
		const planPath = this.relativePlanPath(input.planPath);
		const requestId = safeId(this.requestIdFactory(), "requestId");
		if ([...this.pending.values()].some((pending) => pending.requestId === requestId)) {
			throw new Error("Duplicate approval request id");
		}
		const response = await this.requestFromPlannotator(requestId, {
			planContent: input.planContent,
			planFilePath: planPath,
		});
		const reviewId = parseReviewResponse(response);
		if (this.pending.has(reviewId)) throw new Error("Duplicate Plannotator review id");
		this.pending.set(reviewId, { requestId, reviewId, planPath, planContent: input.planContent });
		return { requestId, reviewId };
	}

	async handleReviewResult(value: unknown): Promise<ReviewResultOutcome> {
		let result: ParsedReviewResult;
		try {
			result = parseReviewResult(value);
		} catch {
			this.onError?.("invalid-event");
			return { status: "ignored", reason: "invalid-event" };
		}
		const pending = this.pending.get(result.reviewId);
		if (!pending) return { status: "ignored", reason: "unknown-review" };
		const receipt = createApprovalReceipt({
			provider: "plannotator",
			requestId: pending.requestId,
			reviewId: pending.reviewId,
			decision: result.approved ? "approved" : "rejected",
			decidedAt: this.clock().toISOString(),
			sessionId: this.sessionId,
			planPath: pending.planPath,
			planContent: pending.planContent,
			...(result.feedback ? { feedback: result.feedback } : {}),
		});
		const write = this.store.write(receipt);
		this.pending.delete(result.reviewId);
		await this.onReceipt?.(receipt, write);
		return { status: "persisted", receipt, write };
	}
}
