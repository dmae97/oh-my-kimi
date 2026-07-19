// allow: SIZE_OK - evidence ledger guardrails: tamper-evident replay chain + fail-closed parsing.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	EvidenceCommandDescriptor,
	EvidenceItem,
	EvidenceReceiptMode,
	EvidenceStatus,
	MergeGateResult,
	MergeGateStatus,
	ReplayEvent,
	ReplayLedger,
	ReplayLedgerHead,
	TaskContract,
	VerifiedReplayLedgerSnapshot,
	WorkspaceScope,
} from "../types/evidence.ts";
import { redactCommandDescriptor } from "./command-redaction.ts";
import {
	type CommandHmacBinder,
	latestRelevantWorkspaceMutationSeq,
	parseVerifiedLedgerSnapshot,
	replayPayloadMatches,
	verifyCommandAttestation,
	verifyWorkspaceBinding,
} from "./evidence-attestation.ts";

export { latestRelevantWorkspaceMutationSeq } from "./evidence-attestation.ts";

import {
	computeEvidenceCommandSha256,
	constantTimeSha256Equal,
	evidenceReceiptReplayPayload,
	parseSha256Hex,
	validateEvidenceReceipt,
} from "./evidence-receipt.ts";
import { ReplayLedgerStore, replayLedgerHeadsEqual } from "./replay-ledger-store.ts";

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function ensureDir(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

// ============================================================================
// TaskContract
// ============================================================================

export class TaskContractBuilder {
	private goalId: string;
	private completionClaim: string = "";
	private requiredEvidence: EvidenceItem[] = [];
	private finalRisk: string = "";
	private verdict: "pass" | "fail" | "conditional" = "fail";
	private createdAt: string;
	private updatedAt: string;

	constructor(goalId: string) {
		this.goalId = goalId;
		const now = new Date().toISOString();
		this.createdAt = now;
		this.updatedAt = now;
	}

	setClaim(claim: string): this {
		this.completionClaim = claim;
		this.touch();
		return this;
	}

	addRequiredEvidence(evidence: Omit<EvidenceItem, "timestamp" | "status">): this {
		this.requiredEvidence.push({
			...evidence,
			timestamp: new Date().toISOString(),
			status: "pending",
		});
		this.touch();
		return this;
	}

	setFinalRisk(risk: string): this {
		this.finalRisk = risk;
		this.touch();
		return this;
	}

	setVerdict(verdict: "pass" | "fail" | "conditional"): this {
		this.verdict = verdict;
		this.touch();
		return this;
	}

	updateEvidenceStatus(claim: string, status: EvidenceStatus, gapReason?: string): this {
		const item = this.requiredEvidence.find((e) => e.claim === claim);
		if (item) {
			item.status = status;
			item.gapReason = gapReason;
			item.timestamp = new Date().toISOString();
			this.touch();
		}
		return this;
	}

	private touch(): void {
		this.updatedAt = new Date().toISOString();
	}

	build(): TaskContract {
		return structuredClone({
			goalId: this.goalId,
			completionClaim: this.completionClaim,
			requiredEvidence: this.requiredEvidence,
			finalRisk: this.finalRisk,
			verdict: this.verdict,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
		});
	}

	/** Parse and validate a serialized TaskContract. Fails closed on any shape violation. */
	static fromJSON(json: string): TaskContract {
		const raw: unknown = JSON.parse(json);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("TaskContract JSON must be an object");
		}
		const { goalId, completionClaim, finalRisk, verdict, createdAt, updatedAt, requiredEvidence } = raw as Record<
			string,
			unknown
		>;
		if (
			typeof goalId !== "string" ||
			typeof completionClaim !== "string" ||
			typeof finalRisk !== "string" ||
			typeof createdAt !== "string" ||
			typeof updatedAt !== "string"
		) {
			throw new Error("TaskContract JSON has missing or mistyped string fields");
		}
		if (verdict !== "pass" && verdict !== "fail" && verdict !== "conditional") {
			throw new Error(`TaskContract verdict must be pass|fail|conditional, got ${String(verdict)}`);
		}
		if (!Array.isArray(requiredEvidence)) {
			throw new Error("TaskContract requiredEvidence must be an array");
		}
		return {
			goalId,
			completionClaim,
			finalRisk,
			verdict,
			createdAt,
			updatedAt,
			requiredEvidence: requiredEvidence.map((item, index) => parseEvidenceItem(item, index)),
		};
	}

	static toJSON(contract: TaskContract): string {
		return JSON.stringify(contract, null, 2);
	}
}

const EVIDENCE_STATUSES: ReadonlySet<string> = new Set(["pending", "gathering", "satisfied", "failed", "waived"]);

function optionalStringField(value: unknown, field: string, index: number): string | undefined {
	if (value !== undefined && typeof value !== "string") {
		throw new Error(`TaskContract evidence[${index}].${field} must be a string when present`);
	}
	return value;
}

function parseEvidenceItem(raw: unknown, index: number): EvidenceItem {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`TaskContract evidence[${index}] must be an object`);
	}
	const item = raw as Record<string, unknown>;
	const { claim, category, timestamp, status } = item;
	if (typeof claim !== "string" || typeof category !== "string" || typeof timestamp !== "string") {
		throw new Error(`TaskContract evidence[${index}] has missing or mistyped fields`);
	}
	if (typeof status !== "string" || !EVIDENCE_STATUSES.has(status)) {
		throw new Error(`TaskContract evidence[${index}] has invalid status ${String(status)}`);
	}
	const receiptSchemaVersion = item.receiptSchemaVersion;
	if (receiptSchemaVersion !== undefined && receiptSchemaVersion !== 3) {
		throw new Error(`TaskContract evidence[${index}].receiptSchemaVersion must be 3 when present`);
	}
	const receiptCommandSha256 = optionalStringField(item.receiptCommandSha256, "receiptCommandSha256", index);
	return {
		claim,
		category: category as EvidenceItem["category"],
		timestamp,
		status: status as EvidenceStatus,
		artifactPath: optionalStringField(item.artifactPath, "artifactPath", index),
		verificationCommand: optionalStringField(item.verificationCommand, "verificationCommand", index),
		hash: optionalStringField(item.hash, "hash", index),
		receiptId: optionalStringField(item.receiptId, "receiptId", index),
		receiptSchemaVersion,
		...(receiptCommandSha256 !== undefined
			? { receiptCommandSha256: parseSha256Hex(receiptCommandSha256, "receiptCommandSha256") }
			: {}),
		receiptLaneId: optionalStringField(item.receiptLaneId, "receiptLaneId", index),
		gapReason: optionalStringField(item.gapReason, "gapReason", index),
	};
}

// ============================================================================
// ReplayLedger
// ============================================================================

/** prevHash sentinel for the first event in a replay chain. */
const GENESIS_HASH = "genesis";

function computeEventHash(event: Omit<ReplayEvent, "eventHash">): string {
	return sha256(
		JSON.stringify([
			event.seq,
			event.type,
			event.timestamp,
			event.goalId,
			event.laneId ?? null,
			event.payloadHash,
			event.prevHash,
		]),
	);
}

function parseReplayEventLine(line: string, lineNumber: number): ReplayEvent {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		throw new Error(`Replay ledger corrupted at line ${lineNumber}: invalid JSON`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Replay ledger corrupted at line ${lineNumber}: event must be an object`);
	}
	const event = raw as Record<string, unknown>;
	const { seq, type, timestamp, goalId, laneId, payloadHash, prevHash, eventHash } = event;
	if (
		typeof seq !== "number" ||
		typeof type !== "string" ||
		typeof timestamp !== "string" ||
		typeof goalId !== "string" ||
		typeof payloadHash !== "string" ||
		typeof prevHash !== "string" ||
		typeof eventHash !== "string" ||
		(laneId !== undefined && typeof laneId !== "string") ||
		!("payload" in event)
	) {
		throw new Error(`Replay ledger corrupted at line ${lineNumber}: event fields are missing or mistyped`);
	}
	return {
		seq,
		type: type as ReplayEvent["type"],
		timestamp,
		goalId,
		laneId,
		payload: event.payload,
		payloadHash,
		prevHash,
		eventHash,
	};
}

function parseReplayLedgerBytes(bytes: Buffer, goalId: string): ReplayEvent[] {
	const lines = bytes
		.toString("utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
	const events: ReplayEvent[] = [];
	let prevHash = GENESIS_HASH;
	for (let index = 0; index < lines.length; index++) {
		const event = parseReplayEventLine(lines[index], index + 1);
		if (event.goalId !== goalId) throw new Error(`Replay ledger goal mismatch at line ${index + 1}`);
		if (event.seq !== index + 1) {
			throw new Error(`Replay ledger corrupted at line ${index + 1}: expected seq ${index + 1}, got ${event.seq}`);
		}
		if (event.prevHash !== prevHash) throw new Error(`Replay ledger chain broken at line ${index + 1}`);
		if (sha256(JSON.stringify(event.payload)) !== event.payloadHash) {
			throw new Error(`Replay ledger payload tampered at line ${index + 1} (seq ${event.seq})`);
		}
		if (computeEventHash(event) !== event.eventHash) {
			throw new Error(`Replay ledger event hash mismatch at line ${index + 1} (seq ${event.seq})`);
		}
		prevHash = event.eventHash;
		events.push(event);
	}
	return events;
}

export class ReplayLedgerManager {
	private readonly goalId: string;
	private readonly ledgerPath: string;
	private readonly store: ReplayLedgerStore;
	private events: ReplayEvent[] = [];
	private committedHead: ReplayLedgerHead;

	constructor(goalId: string, ledgerPath: string, expectedHead?: ReplayLedgerHead) {
		this.goalId = goalId;
		this.ledgerPath = ledgerPath;
		this.committedHead = { fileIdentity: null, size: 0, lastSeq: 0, lastHash: GENESIS_HASH };
		this.store = new ReplayLedgerStore(ledgerPath, (bytes) => {
			const events = parseReplayLedgerBytes(bytes, goalId);
			const last = events.at(-1);
			return { lastSeq: last?.seq ?? 0, lastHash: last?.eventHash ?? GENESIS_HASH };
		});
		this.refresh(expectedHead);
	}

	private refresh(expectedHead?: ReplayLedgerHead): void {
		const snapshot = this.store.load(expectedHead);
		this.events = parseReplayLedgerBytes(snapshot.bytes, this.goalId);
		this.committedHead = snapshot.head;
	}

	append(
		event: Omit<ReplayEvent, "seq" | "timestamp" | "payloadHash" | "prevHash" | "eventHash">,
		expectedHead: ReplayLedgerHead = this.committedHead,
	): ReplayEvent {
		if (event.goalId !== this.goalId) throw new Error("Replay event goalId does not match the ledger");
		if (!replayLedgerHeadsEqual(expectedHead, this.committedHead)) {
			throw new Error("Replay manager expected-head CAS is stale");
		}
		const payloadHash = sha256(JSON.stringify(event.payload));
		const chained: Omit<ReplayEvent, "eventHash"> = {
			...event,
			seq: expectedHead.lastSeq + 1,
			timestamp: new Date().toISOString(),
			payloadHash,
			prevHash: expectedHead.lastHash,
		};
		const fullEvent: ReplayEvent = { ...chained, eventHash: computeEventHash(chained) };
		this.committedHead = this.store.append(
			Buffer.from(`${JSON.stringify(fullEvent)}\n`, "utf8"),
			fullEvent.seq,
			fullEvent.eventHash,
			expectedHead,
		);
		this.events.push(fullEvent);
		return structuredClone(fullEvent);
	}

	/** Compatibility no-op that still verifies the caller's expected committed head. */
	persist(expectedHead: ReplayLedgerHead = this.committedHead): void {
		this.getVerifiedSnapshot(expectedHead);
	}

	load(expectedHead: ReplayLedgerHead = this.committedHead): void {
		this.refresh(expectedHead);
	}

	getCommittedHead(): ReplayLedgerHead {
		return structuredClone(this.committedHead);
	}

	getVerifiedSnapshot(expectedHead: ReplayLedgerHead = this.committedHead): VerifiedReplayLedgerSnapshot {
		this.refresh(expectedHead);
		return structuredClone({ events: this.events, head: this.committedHead });
	}

	getEvents(): ReadonlyArray<ReplayEvent> {
		return structuredClone(this.events);
	}

	getLedger(): Readonly<ReplayLedger> {
		return structuredClone({
			goalId: this.goalId,
			events: this.events,
			ledgerPath: this.ledgerPath,
			lastPersistedSeq: this.committedHead.lastSeq,
		});
	}

	replay<T>(handler: (event: ReplayEvent) => T | undefined): T[] {
		return this.events.map(handler).filter((result): result is T => result !== undefined);
	}

	exportToFile(path: string): void {
		ensureDir(path);
		writeFileSync(path, JSON.stringify(this.events, null, 2), "utf8");
	}
}

// ============================================================================
// EvidenceGate
// ============================================================================

export interface EvidenceGateOptions {
	/** Minimum number of satisfied evidence items required. */
	minEvidenceCount?: number;
	/** Require at least one artifact with a SHA-256 hash in explicit legacy mode. */
	requireHash?: boolean;
	/** Require at least one verification command in explicit legacy mode. */
	requireVerificationCommand?: boolean;
	/** Receipt policy. Defaults to prefer; legacy must be selected explicitly. */
	receiptMode?: EvidenceReceiptMode;
	/** Resolve a serialized or decoded receipt by ID. The gate validates the returned value. */
	resolveReceipt?: (receiptId: string) => unknown;
	/** Strict source: one expected-head, file-identity, suffix, and chain-verified snapshot. */
	resolveVerifiedLedgerSnapshot?: () => VerifiedReplayLedgerSnapshot;
	/** Prefer-mode migration source; strict mode requires resolveVerifiedLedgerSnapshot. */
	resolveLedgerEvent?: (seq: number) => ReplayEvent | undefined;
	/** Recapture the receipt's workspace scope (same kind and scope) for freshness comparison. */
	captureWorkspaceFingerprint?: (scope: WorkspaceScope) => unknown;
	/**
	 * Optional freshness source: the latest replay-ledger sequence of a workspace mutation
	 * relevant to the given scope, or null/undefined when none is known. When configured,
	 * the receipt's verified ledger seq must strictly exceed this value; a throwing or
	 * out-of-contract source is a hard block (positive safe integers only).
	 */
	resolveLatestWorkspaceMutationSeq?: (scope: WorkspaceScope) => number | null | undefined;
	/** Ephemeral trust anchor used to verify the original command's keyed attestation. */
	commandAttestationBinder?: Pick<CommandHmacBinder, "verify">;
	/** Resolve the original command inside the same trust boundary as the binder. */
	resolveAttestedCommand?: (receiptId: string) => EvidenceCommandDescriptor | undefined;
}

interface ReceiptCheckIssue {
	readonly message: string;
	readonly hard: boolean;
}

function receiptCheckIssue(message: string, hard: boolean): ReceiptCheckIssue {
	return { message, hard };
}

function receiptIssue(
	item: EvidenceItem,
	contract: TaskContract,
	options: EvidenceGateOptions,
): ReceiptCheckIssue | undefined {
	if (!item.receiptId) {
		return receiptCheckIssue(`Execution receipt is missing for evidence "${item.claim}".`, false);
	}
	const strict = options.receiptMode === "strict";
	if (item.receiptSchemaVersion !== 3 && (item.receiptSchemaVersion !== undefined || strict)) {
		return receiptCheckIssue(`Execution receipt schema metadata is invalid for evidence "${item.claim}".`, true);
	}
	if (!options.resolveReceipt) {
		return receiptCheckIssue(`Execution receipt resolver is missing for evidence "${item.claim}".`, false);
	}

	let rawReceipt: unknown;
	try {
		rawReceipt = options.resolveReceipt(item.receiptId);
	} catch {
		return receiptCheckIssue(`Execution receipt resolver failed for evidence "${item.claim}".`, true);
	}
	if (rawReceipt === undefined) {
		return receiptCheckIssue(`Execution receipt is missing for evidence "${item.claim}".`, false);
	}

	try {
		const receipt = validateEvidenceReceipt(rawReceipt);
		if (receipt.core.receiptId !== item.receiptId) {
			return receiptCheckIssue(`Execution receipt ID does not match evidence "${item.claim}".`, true);
		}
		if (receipt.core.goalId !== contract.goalId) {
			return receiptCheckIssue(`Execution receipt goal does not match evidence "${item.claim}".`, true);
		}
		if (receipt.core.claim !== item.claim) {
			return receiptCheckIssue(`Execution receipt claim does not match evidence "${item.claim}".`, true);
		}
		if (receipt.core.status !== "passed" || receipt.core.exitCode !== 0) {
			return receiptCheckIssue(
				`Execution receipt for evidence "${item.claim}" did not pass with exit code 0.`,
				true,
			);
		}

		if (item.receiptCommandSha256 === undefined) {
			return receiptCheckIssue(`Execution receipt command binding is missing for evidence "${item.claim}".`, false);
		}
		const receiptCommandSha256 = computeEvidenceCommandSha256(receipt.core.command);
		if (!constantTimeSha256Equal(item.receiptCommandSha256, receiptCommandSha256)) {
			return receiptCheckIssue(`Execution receipt command does not match evidence "${item.claim}".`, true);
		}
		const attestationIssue = verifyCommandAttestation({
			receiptId: receipt.core.receiptId,
			binding: receipt.core.commandBinding,
			persistedCommand: receipt.core.command,
			persistedSummary: receipt.core.commandRedaction,
			binder: options.commandAttestationBinder,
			resolveCommand: options.resolveAttestedCommand,
			redact: redactCommandDescriptor,
		});
		if (attestationIssue !== undefined) {
			return receiptCheckIssue(
				`Execution receipt command attestation ${attestationIssue.detail} for evidence "${item.claim}".`,
				attestationIssue.hard,
			);
		}

		if (receipt.core.laneId !== undefined && item.receiptLaneId === undefined) {
			return receiptCheckIssue(`Execution receipt lane binding is missing for evidence "${item.claim}".`, false);
		}
		if (item.receiptLaneId !== receipt.core.laneId) {
			return receiptCheckIssue(`Execution receipt lane does not match evidence "${item.claim}".`, true);
		}

		const workspaceIssue = verifyWorkspaceBinding(receipt.core.workspaceAfter, options.captureWorkspaceFingerprint);
		if (workspaceIssue !== undefined) {
			return receiptCheckIssue(
				`Execution receipt ${workspaceIssue.detail} for evidence "${item.claim}".`,
				workspaceIssue.hard,
			);
		}

		let snapshot: VerifiedReplayLedgerSnapshot | undefined;
		if (options.resolveVerifiedLedgerSnapshot !== undefined) {
			try {
				snapshot = parseVerifiedLedgerSnapshot(
					options.resolveVerifiedLedgerSnapshot(),
					contract.goalId,
					parseReplayLedgerBytes,
				);
			} catch {
				return receiptCheckIssue(
					`Execution receipt verified ledger snapshot failed for evidence "${item.claim}".`,
					true,
				);
			}
		} else if (strict) {
			return receiptCheckIssue(
				`Execution receipt verified ledger snapshot is missing for evidence "${item.claim}".`,
				false,
			);
		}
		let latestMutationSeq =
			snapshot === undefined
				? null
				: latestRelevantWorkspaceMutationSeq(snapshot.events, receipt.core.workspaceAfter.scope);
		if (snapshot === undefined && options.resolveLatestWorkspaceMutationSeq !== undefined) {
			let resolved: unknown;
			try {
				resolved = options.resolveLatestWorkspaceMutationSeq(receipt.core.workspaceAfter.scope);
			} catch {
				return receiptCheckIssue(
					`Execution receipt workspace-mutation freshness source failed for evidence "${item.claim}".`,
					true,
				);
			}
			if (resolved !== null && resolved !== undefined) {
				if (!Number.isSafeInteger(resolved) || (resolved as number) <= 0) {
					return receiptCheckIssue(
						`Execution receipt workspace-mutation freshness source is malformed for evidence "${item.claim}".`,
						true,
					);
				}
				latestMutationSeq = resolved as number;
			}
		}

		const binding = receipt.envelope.ledgerBinding;
		if (!binding) {
			return receiptCheckIssue(
				`Execution receipt ledger binding is missing for evidence "${item.claim}".`,
				latestMutationSeq !== null,
			);
		}
		const event = snapshot
			? snapshot.events.find((candidate) => candidate.seq === binding.seq)
			: options.resolveLedgerEvent?.(binding.seq);
		if (!event && snapshot === undefined && !options.resolveLedgerEvent) {
			return receiptCheckIssue(
				`Execution receipt ledger resolver is missing for evidence "${item.claim}".`,
				latestMutationSeq !== null,
			);
		}
		const replayPayload = evidenceReceiptReplayPayload(receipt);
		if (
			!event ||
			event.seq !== binding.seq ||
			event.type !== "evidence_receipt" ||
			event.goalId !== contract.goalId ||
			event.laneId !== receipt.core.laneId ||
			!constantTimeSha256Equal(event.eventHash, binding.eventHash) ||
			!replayPayloadMatches(event.payload, replayPayload.receiptId, replayPayload.coreSha256)
		) {
			return receiptCheckIssue(`Execution receipt ledger binding does not match evidence "${item.claim}".`, true);
		}
		if (latestMutationSeq !== null && event.seq <= latestMutationSeq) {
			return receiptCheckIssue(
				`Execution receipt is stale: workspace mutation seq ${latestMutationSeq} does not precede receipt ledger seq ${event.seq} for evidence "${item.claim}".`,
				true,
			);
		}
	} catch {
		return receiptCheckIssue(`Execution receipt is invalid for evidence "${item.claim}".`, true);
	}
	return undefined;
}

export class EvidenceGate {
	private options: EvidenceGateOptions;

	constructor(options: EvidenceGateOptions = {}) {
		this.options = {
			minEvidenceCount: 1,
			requireHash: true,
			requireVerificationCommand: true,
			receiptMode: "prefer",
			...options,
		};
	}

	check(contract: TaskContract): MergeGateResult {
		const evidence = contract.requiredEvidence;
		const satisfied = evidence.filter((e) => e.status === "satisfied");
		const failed = evidence.filter((e) => e.status === "failed");
		const pending = evidence.filter((e) => e.status === "pending" || e.status === "gathering");
		const mode = this.options.receiptMode ?? "prefer";
		const checks: string[] = [];
		let hardReceiptFailure = false;

		if (satisfied.length < (this.options.minEvidenceCount ?? 1)) {
			checks.push(`Only ${satisfied.length}/${this.options.minEvidenceCount} required evidence items satisfied.`);
		}
		if (failed.length > 0) {
			checks.push(`${failed.length} evidence item(s) failed.`);
		}

		if (mode === "legacy") {
			if (this.options.requireHash) {
				const hashed = satisfied.filter((e) => e.hash && e.hash.length > 0);
				if (hashed.length === 0) checks.push("No satisfied evidence has a SHA-256 hash.");
			}
			if (this.options.requireVerificationCommand) {
				const withCommand = satisfied.filter((e) => e.verificationCommand && e.verificationCommand.length > 0);
				if (withCommand.length === 0) checks.push("No satisfied evidence has a verification command.");
			}
		} else {
			const unsatisfied = evidence.filter((item) => item.status !== "satisfied");
			if (unsatisfied.length > 0) {
				checks.push(`${unsatisfied.length} required evidence item(s) are not satisfied.`);
			}
			for (const item of satisfied) {
				const issue = receiptIssue(item, contract, this.options);
				if (issue) {
					checks.push(issue.message);
					hardReceiptFailure ||= issue.hard;
				}
			}
		}

		if (contract.verdict === "fail" || (mode !== "legacy" && contract.verdict !== "pass")) {
			checks.push(`Task contract verdict is '${contract.verdict}'.`);
		}

		let status: MergeGateStatus;
		let reason: string;
		let suggestion: string | undefined;
		if (checks.length === 0) {
			status = "open";
			reason = `Evidence gate passed: ${satisfied.length}/${evidence.length} evidence items satisfied.`;
		} else {
			const contractFailure = mode === "legacy" ? contract.verdict === "fail" : contract.verdict !== "pass";
			const hasHardFailure = failed.length > 0 || contractFailure || hardReceiptFailure || mode === "strict";
			status = hasHardFailure ? "blocked" : mode === "prefer" || pending.length > 0 ? "conditional" : "blocked";
			reason = checks.join("; ");
			suggestion = `Gather remaining evidence (${pending.length} pending) and re-run verification.`;
		}

		return {
			gateId: "evidence-gate",
			status,
			reason,
			suggestion,
			evidenceChecked: evidence,
		};
	}
}

// ============================================================================
// FailClosedMergeGate
// ============================================================================

export class FailClosedMergeGate {
	private gates: EvidenceGate[];

	constructor(gates: EvidenceGate[] = [new EvidenceGate()]) {
		this.gates = gates;
	}

	check(contract: TaskContract): MergeGateResult {
		const results = this.gates.map((gate) => gate.check(contract));
		const blocked = results.filter((r) => r.status === "blocked");
		const conditional = results.filter((r) => r.status === "conditional");

		if (blocked.length > 0) {
			return {
				gateId: "fail-closed-merge-gate",
				status: "blocked",
				reason: `Blocked by ${blocked.length} gate(s): ${blocked.map((b) => b.reason).join("; ")}`,
				suggestion: "Resolve all blocking conditions before merge.",
				evidenceChecked: contract.requiredEvidence,
			};
		}

		if (conditional.length > 0) {
			return {
				gateId: "fail-closed-merge-gate",
				status: "conditional",
				reason: `Conditional pass: ${conditional.length} gate(s) have pending conditions.`,
				suggestion: "Complete pending evidence or waive with explicit approval.",
				evidenceChecked: contract.requiredEvidence,
			};
		}

		return {
			gateId: "fail-closed-merge-gate",
			status: "open",
			reason: "All merge gates passed. Evidence verified and contract verdict is acceptable.",
			evidenceChecked: contract.requiredEvidence,
		};
	}
}

// ============================================================================
// Verify Reporter v2
// ============================================================================

/** Escape pipes/newlines so untrusted claim or command text cannot restructure the report table. */
function escapeTableCell(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export interface VerifyReporterV2Options {
	outputDir: string;
	goalId: string;
}

export class VerifyReporterV2 {
	private options: VerifyReporterV2Options;

	constructor(options: VerifyReporterV2Options) {
		this.options = options;
	}

	render(contract: TaskContract, mergeGate: MergeGateResult): string {
		const lines: string[] = [
			`## OMK Verification Report v2 — ${contract.goalId}`,
			"",
			"### Contract",
			"",
			`| Field | Value |`,
			`|-------|-------|`,
			`| Claim | ${escapeTableCell(contract.completionClaim)} |`,
			`| Verdict | ${contract.verdict} |`,
			`| Final Risk | ${escapeTableCell(contract.finalRisk)} |`,
			"",
			"### Evidence",
			"",
			`| Claim | Status | Artifact | Command |`,
			`|-------|--------|----------|----------|`,
		];

		for (const ev of contract.requiredEvidence) {
			lines.push(
				`| ${escapeTableCell(ev.claim)} | ${ev.status} | ${escapeTableCell(ev.artifactPath ?? "—")} | ${escapeTableCell(ev.verificationCommand ?? "—")} |`,
			);
		}

		lines.push(
			"",
			"### Merge Gate",
			"",
			`| Gate | Status | Reason |`,
			`|------|--------|--------|`,
			`| ${mergeGate.gateId} | ${mergeGate.status} | ${escapeTableCell(mergeGate.reason)} |`,
			"",
		);

		if (mergeGate.suggestion) {
			lines.push(`**Suggestion:** ${mergeGate.suggestion}`, "");
		}

		return lines.join("\n");
	}

	write(contract: TaskContract, mergeGate: MergeGateResult): string {
		const markdown = this.render(contract, mergeGate);
		const path = join(this.options.outputDir, `${this.options.goalId}.verify.md`);
		ensureDir(path);
		writeFileSync(path, markdown, "utf-8");
		return path;
	}
}
