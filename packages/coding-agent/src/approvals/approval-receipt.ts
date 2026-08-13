import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const CORE_DOMAIN = "omk.approval-receipt.core.v1\0";
const ID_DOMAIN = "omk.approval-receipt.id.v1\0";

export type ApprovalDecision = "approved" | "rejected" | "invalidated";

export interface ApprovalContentDigest {
	sha256: string;
	bytes: number;
}

export interface ApprovalPlanDigest extends ApprovalContentDigest {
	path: string;
}

export interface ApprovalReceiptCore {
	schemaVersion: 1;
	receiptId: string;
	provider: "plannotator";
	trust: "external-extension-event";
	requestId: string;
	reviewId: string;
	decision: ApprovalDecision;
	decidedAt: string;
	sessionId: string;
	plan: ApprovalPlanDigest;
	feedback?: ApprovalContentDigest;
}

export interface ApprovalReceipt {
	core: ApprovalReceiptCore;
	coreSha256: string;
}

export interface CreateApprovalReceiptInput {
	provider: "plannotator";
	requestId: string;
	reviewId: string;
	decision: ApprovalDecision;
	decidedAt: string;
	sessionId: string;
	planPath: string;
	planContent: string;
	feedback?: string;
}

function sha256(domain: string, value: string): string {
	return createHash("sha256").update(domain).update(value, "utf8").digest("hex");
}

export function computeApprovalContentDigest(value: string): ApprovalContentDigest {
	return { sha256: sha256("omk.approval-content.v1\0", value), bytes: Buffer.byteLength(value, "utf8") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`Unexpected approval receipt field: ${key}`);
	}
	for (const key of required) {
		if (!hasOwn(value, key)) throw new Error(`Missing approval receipt field: ${key}`);
	}
}

function safeId(value: unknown, label: string): string {
	if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) throw new Error(`${label} is not a safe identifier`);
	return value;
}

function sha256Hex(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new Error(`${label} must be a non-negative safe integer`);
	return value as number;
}

function workspaceRelativePath(value: unknown): string {
	if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
		throw new Error("plan.path must be workspace-relative");
	}
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error("plan.path must be workspace-relative");
	}
	return value;
}

function timestamp(value: unknown): string {
	if (typeof value !== "string") throw new Error("decidedAt must be an ISO timestamp");
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		throw new Error("decidedAt must be a canonical ISO timestamp");
	}
	return value;
}

function parseContentDigest(value: unknown, label: string): ApprovalContentDigest {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	exactKeys(value, ["sha256", "bytes"]);
	return {
		sha256: sha256Hex(value.sha256, `${label}.sha256`),
		bytes: nonNegativeInteger(value.bytes, `${label}.bytes`),
	};
}

function parsePlan(value: unknown): ApprovalPlanDigest {
	if (!isRecord(value)) throw new Error("plan must be an object");
	exactKeys(value, ["path", "sha256", "bytes"]);
	return {
		path: workspaceRelativePath(value.path),
		sha256: sha256Hex(value.sha256, "plan.sha256"),
		bytes: nonNegativeInteger(value.bytes, "plan.bytes"),
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Approval receipt contains a non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (!isRecord(value)) throw new Error("Approval receipt contains an unsupported value");
	return `{${Object.keys(value)
		.sort((left, right) => left.localeCompare(right))
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
		.join(",")}}`;
}

export function computeApprovalReceiptCoreSha256(core: ApprovalReceiptCore): string {
	return sha256(CORE_DOMAIN, canonicalJson(core));
}

function constantTimeEqual(left: string, right: string): boolean {
	if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
	return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function validateApprovalReceipt(value: unknown): ApprovalReceipt {
	if (!isRecord(value)) throw new Error("Approval receipt must be an object");
	exactKeys(value, ["core", "coreSha256"]);
	if (!isRecord(value.core)) throw new Error("Approval receipt core must be an object");
	const coreValue = value.core;
	exactKeys(
		coreValue,
		[
			"schemaVersion",
			"receiptId",
			"provider",
			"trust",
			"requestId",
			"reviewId",
			"decision",
			"decidedAt",
			"sessionId",
			"plan",
		],
		["feedback"],
	);
	if (coreValue.schemaVersion !== 1) throw new Error("Unsupported approval receipt schemaVersion");
	if (coreValue.provider !== "plannotator") throw new Error("Unsupported approval provider");
	if (coreValue.trust !== "external-extension-event") throw new Error("Invalid approval trust classification");
	if (coreValue.decision !== "approved" && coreValue.decision !== "rejected" && coreValue.decision !== "invalidated") {
		throw new Error("Invalid approval decision");
	}
	const core: ApprovalReceiptCore = {
		schemaVersion: 1,
		receiptId: safeId(coreValue.receiptId, "receiptId"),
		provider: "plannotator",
		trust: "external-extension-event",
		requestId: safeId(coreValue.requestId, "requestId"),
		reviewId: safeId(coreValue.reviewId, "reviewId"),
		decision: coreValue.decision,
		decidedAt: timestamp(coreValue.decidedAt),
		sessionId: safeId(coreValue.sessionId, "sessionId"),
		plan: parsePlan(coreValue.plan),
		...(hasOwn(coreValue, "feedback") ? { feedback: parseContentDigest(coreValue.feedback, "feedback") } : {}),
	};
	const expectedReceiptId = computeApprovalReceiptId(core);
	if (core.receiptId !== expectedReceiptId) throw new Error("Approval receipt id mismatch");
	const coreSha256 = sha256Hex(value.coreSha256, "coreSha256");
	const expectedDigest = computeApprovalReceiptCoreSha256(core);
	if (!constantTimeEqual(coreSha256, expectedDigest)) throw new Error("Approval receipt digest mismatch");
	return { core, coreSha256 };
}

function computeApprovalReceiptId(
	core: Omit<ApprovalReceiptCore, "receiptId" | "decidedAt" | "decision" | "feedback">,
): string {
	const identity = {
		schemaVersion: core.schemaVersion,
		provider: core.provider,
		trust: core.trust,
		requestId: core.requestId,
		reviewId: core.reviewId,
		sessionId: core.sessionId,
		plan: core.plan,
	};
	return `approval-${sha256(ID_DOMAIN, canonicalJson(identity)).slice(0, 32)}`;
}

export function createApprovalReceipt(input: CreateApprovalReceiptInput): ApprovalReceipt {
	const plan: ApprovalPlanDigest = {
		path: workspaceRelativePath(input.planPath),
		...computeApprovalContentDigest(input.planContent),
	};
	const coreWithoutId = {
		schemaVersion: 1 as const,
		provider: input.provider,
		trust: "external-extension-event" as const,
		requestId: safeId(input.requestId, "requestId"),
		reviewId: safeId(input.reviewId, "reviewId"),
		decision: input.decision,
		decidedAt: timestamp(input.decidedAt),
		sessionId: safeId(input.sessionId, "sessionId"),
		plan,
		...(input.feedback !== undefined && input.feedback.length > 0
			? { feedback: computeApprovalContentDigest(input.feedback) }
			: {}),
	};
	const core: ApprovalReceiptCore = {
		...coreWithoutId,
		receiptId: computeApprovalReceiptId(coreWithoutId),
	};
	return validateApprovalReceipt({ core, coreSha256: computeApprovalReceiptCoreSha256(core) });
}

export function parseApprovalReceipt(serialized: string): ApprovalReceipt {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized) as unknown;
	} catch {
		throw new Error("Approval receipt is not valid JSON");
	}
	return validateApprovalReceipt(parsed);
}

export function serializeApprovalReceipt(receipt: ApprovalReceipt): string {
	return `${JSON.stringify(validateApprovalReceipt(receipt), null, 2)}\n`;
}
