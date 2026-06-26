// allow: SIZE_OK - legacy evidence ledger; this change only keeps typed import/check compatibility.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	EvidenceItem,
	EvidenceStatus,
	MergeGateResult,
	MergeGateStatus,
	ReplayEvent,
	ReplayLedger,
	TaskContract,
} from "../types/evidence.ts";

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
		return {
			goalId: this.goalId,
			completionClaim: this.completionClaim,
			requiredEvidence: [...this.requiredEvidence],
			finalRisk: this.finalRisk,
			verdict: this.verdict,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
		};
	}

	static fromJSON(json: string): TaskContract {
		return JSON.parse(json) as TaskContract;
	}

	static toJSON(contract: TaskContract): string {
		return JSON.stringify(contract, null, 2);
	}
}

// ============================================================================
// ReplayLedger
// ============================================================================

export class ReplayLedgerManager {
	private ledger: ReplayLedger;
	private nextSeq: number;

	constructor(goalId: string, ledgerPath: string) {
		ensureDir(ledgerPath);
		this.ledger = {
			goalId,
			events: [],
			ledgerPath,
			lastPersistedSeq: 0,
		};
		this.nextSeq = 1;
		if (existsSync(ledgerPath)) {
			this.load();
		}
	}

	append(event: Omit<ReplayEvent, "seq" | "timestamp" | "payloadHash">): ReplayEvent {
		const payloadStr = JSON.stringify(event.payload);
		const fullEvent: ReplayEvent = {
			...event,
			seq: this.nextSeq++,
			timestamp: new Date().toISOString(),
			payloadHash: sha256(payloadStr),
		};
		this.ledger.events.push(fullEvent);
		return fullEvent;
	}

	persist(): void {
		if (this.ledger.events.length === 0) return;
		const last = this.ledger.events[this.ledger.events.length - 1];
		if (last.seq <= this.ledger.lastPersistedSeq) return;

		const newEvents = this.ledger.events.filter((e) => e.seq > this.ledger.lastPersistedSeq);
		const lines = `${newEvents.map((e) => JSON.stringify(e)).join("\n")}\n`;
		appendFileSync(this.ledger.ledgerPath, lines, "utf-8");
		this.ledger.lastPersistedSeq = last.seq;
	}

	load(): void {
		if (!existsSync(this.ledger.ledgerPath)) return;
		const content = readFileSync(this.ledger.ledgerPath, "utf-8");
		const events = content
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as ReplayEvent);
		this.ledger.events = events;
		this.ledger.lastPersistedSeq = events.length > 0 ? events[events.length - 1].seq : 0;
		this.nextSeq = this.ledger.lastPersistedSeq + 1;
	}

	getEvents(): ReadonlyArray<ReplayEvent> {
		return this.ledger.events;
	}

	getLedger(): Readonly<ReplayLedger> {
		return { ...this.ledger };
	}

	replay<T>(handler: (event: ReplayEvent) => T | undefined): T[] {
		const results: T[] = [];
		for (const event of this.ledger.events) {
			const result = handler(event);
			if (result !== undefined) {
				results.push(result);
			}
		}
		return results;
	}

	exportToFile(path: string): void {
		ensureDir(path);
		writeFileSync(path, JSON.stringify(this.ledger.events, null, 2), "utf-8");
	}
}

// ============================================================================
// EvidenceGate
// ============================================================================

export interface EvidenceGateOptions {
	/** Minimum number of satisfied evidence items required. */
	minEvidenceCount?: number;
	/** Require at least one artifact with a SHA-256 hash. */
	requireHash?: boolean;
	/** Require at least one verification command. */
	requireVerificationCommand?: boolean;
}

export class EvidenceGate {
	private options: EvidenceGateOptions;

	constructor(options: EvidenceGateOptions = {}) {
		this.options = {
			minEvidenceCount: 1,
			requireHash: true,
			requireVerificationCommand: true,
			...options,
		};
	}

	check(contract: TaskContract): MergeGateResult {
		const evidence = contract.requiredEvidence;
		const satisfied = evidence.filter((e) => e.status === "satisfied");
		const failed = evidence.filter((e) => e.status === "failed");
		const pending = evidence.filter((e) => e.status === "pending" || e.status === "gathering");

		const checks: string[] = [];

		// Check 1: minimum evidence count
		if (satisfied.length < (this.options.minEvidenceCount ?? 1)) {
			checks.push(`Only ${satisfied.length}/${this.options.minEvidenceCount} required evidence items satisfied.`);
		}

		// Check 2: no failed evidence
		if (failed.length > 0) {
			checks.push(`${failed.length} evidence item(s) failed.`);
		}

		// Check 3: require hash
		if (this.options.requireHash) {
			const hashed = satisfied.filter((e) => e.hash && e.hash.length > 0);
			if (hashed.length === 0) {
				checks.push("No satisfied evidence has a SHA-256 hash.");
			}
		}

		// Check 4: require verification command
		if (this.options.requireVerificationCommand) {
			const withCommand = satisfied.filter((e) => e.verificationCommand && e.verificationCommand.length > 0);
			if (withCommand.length === 0) {
				checks.push("No satisfied evidence has a verification command.");
			}
		}

		// Check 5: contract verdict
		if (contract.verdict === "fail") {
			checks.push("Task contract verdict is 'fail'.");
		}

		let status: MergeGateStatus;
		let reason: string;
		let suggestion: string | undefined;

		if (checks.length === 0) {
			status = "open";
			reason = `Evidence gate passed: ${satisfied.length}/${evidence.length} evidence items satisfied.`;
		} else {
			// If there are pending items and no hard failures, it's conditional; otherwise blocked
			const hasHardFailure = failed.length > 0 || contract.verdict === "fail";
			status = pending.length > 0 && !hasHardFailure ? "conditional" : "blocked";
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
			`| Claim | ${contract.completionClaim} |`,
			`| Verdict | ${contract.verdict} |`,
			`| Final Risk | ${contract.finalRisk} |`,
			"",
			"### Evidence",
			"",
			`| Claim | Status | Artifact | Command |`,
			`|-------|--------|----------|----------|`,
		];

		for (const ev of contract.requiredEvidence) {
			lines.push(`| ${ev.claim} | ${ev.status} | ${ev.artifactPath ?? "—"} | ${ev.verificationCommand ?? "—"} |`);
		}

		lines.push(
			"",
			"### Merge Gate",
			"",
			`| Gate | Status | Reason |`,
			`|------|--------|--------|`,
			`| ${mergeGate.gateId} | ${mergeGate.status} | ${mergeGate.reason} |`,
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
