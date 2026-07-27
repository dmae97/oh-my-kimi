/**
 * Session compaction service: capture / barrier / repair / transaction / commit.
 *
 * Extracted from AgentSession so the session keeps lifecycle orchestration
 * (abort controllers, extension events, auth, model resolution) while this
 * owns the integrity-critical compaction state machine. Every method preserves
 * the exact semantics of the original session implementation — the
 * compaction-transaction / session-integrity suites pin them.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { repairTranscriptIntegrity } from "omk-agent-core";
import type { Api, Message, Model, ToolResultMessage } from "omk-ai";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { CompactionResult } from "./compaction/index.ts";
import {
	type CompactionBarrierResult,
	type CompactionEnvelope,
	type CompactionPreservedProvenanceInput,
	type CompactionSourceIdentity,
	type CompactionTransaction,
	createCompactionEnvelope,
	createCompactionSourceIdentity,
	createCompactionTransaction,
	decideCompactionCommit,
	evaluateCompactionBarrier,
	validateCompactionEnvelope,
} from "./compaction/transaction.ts";
import { redactSensitiveText } from "./redaction.ts";
import type { SessionIntegrityReport } from "./session-integrity.ts";
import { inspectSessionIntegrity } from "./session-integrity.ts";
import type { CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";

export interface CapturedCompactionState {
	readonly report: SessionIntegrityReport;
	readonly branchEntries: readonly SessionEntry[];
	readonly revision: CompactionTransaction["baseRevision"];
	readonly source: CompactionSourceIdentity;
}

export interface BegunCompaction {
	readonly capture: CapturedCompactionState;
	readonly transaction: CompactionTransaction;
}

export interface CommittedCompaction {
	readonly entry: CompactionEntry;
	readonly envelope: CompactionEnvelope;
}

export interface SessionCompactionServiceDeps {
	readonly sessionManager: SessionManager;
	readonly pendingToolCallIds: () => ReadonlySet<string>;
	readonly getUserMessageText: (message: Message) => string;
	readonly cwd: string;
	readonly invalidateContextBudget: () => void;
	/** Refresh agent messages from the session manager after tail repair/commit. */
	readonly refreshAgentMessages: () => void;
	/** Hysteresis bookkeeping after a successful commit. */
	readonly recordCommit: () => void;
}

export class SessionCompactionService {
	private readonly deps: SessionCompactionServiceDeps;

	constructor(deps: SessionCompactionServiceDeps) {
		this.deps = deps;
	}

	captureState(): CapturedCompactionState {
		return this.deps.sessionManager.withCompactionCommitLock(() => this.captureStateLocked());
	}

	private captureStateLocked(): CapturedCompactionState {
		const { sessionManager } = this.deps;
		const sessionFile = sessionManager.getSessionFile();
		const bytes =
			sessionFile && existsSync(sessionFile)
				? new Uint8Array(readFileSync(sessionFile))
				: new TextEncoder().encode(
						`${[sessionManager.getHeader(), ...sessionManager.getEntries()]
							.filter((entry) => entry !== null)
							.map((entry) => JSON.stringify(entry))
							.join("\n")}\n`,
					);
		const report = inspectSessionIntegrity(bytes, { activeLeafId: sessionManager.getLeafId() });
		const branchEntries = report.activeBranch;
		let latestCompactionIndex = -1;
		for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
			if (branchEntries[index]?.type === "compaction") {
				latestCompactionIndex = index;
				break;
			}
		}
		const latestCompaction = branchEntries[latestCompactionIndex];
		const firstKeptIndex =
			latestCompaction?.type === "compaction"
				? branchEntries.findIndex((entry) => entry.id === latestCompaction.firstKeptEntryId)
				: -1;
		const sourceEntries = branchEntries.slice(
			latestCompactionIndex < 0 ? 0 : firstKeptIndex < 0 ? latestCompactionIndex : firstKeptIndex,
		);
		const firstEntry = sourceEntries[0];
		const lastEntry = sourceEntries.at(-1);
		if (!firstEntry || !lastEntry || report.activeLeafId === null) {
			const barrier = evaluateCompactionBarrier(report, [...this.deps.pendingToolCallIds()]);
			if (barrier.status !== "ready") throw this.barrierError(barrier);
			throw new Error("Nothing to compact: the active session branch is empty");
		}
		const revision = sessionManager.getDurableHeadToken();
		const source = createCompactionSourceIdentity({
			sessionId: revision.sessionId,
			entryIds: sourceEntries.map((entry) => entry.id),
			firstEntryId: firstEntry.id,
			lastEntryId: lastEntry.id,
			sourceSha256: createHash("sha256")
				.update(sourceEntries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8")
				.digest("hex"),
			activeLeafId: report.activeLeafId,
			messageCount: report.activeMessages.length,
		});
		return { report, branchEntries, revision, source };
	}

	barrierError(barrier: CompactionBarrierResult): Error {
		if (barrier.status === "defer") {
			return new Error(`Compaction deferred until the transcript closes (${barrier.reason})`);
		}
		return new Error(
			`Compaction failed closed on transcript integrity (${barrier.reason}). Run the session doctor before retrying.`,
		);
	}

	evaluateBarrier(
		capture: CapturedCompactionState,
		includeMissingTailAsPending: boolean,
		excludedPendingIds: ReadonlySet<string> = new Set(),
	): CompactionBarrierResult {
		const pending = new Set([...this.deps.pendingToolCallIds()].filter((id) => !excludedPendingIds.has(id)));
		if (includeMissingTailAsPending) {
			for (const issue of capture.report.transcript?.issues ?? []) {
				if (issue.kind === "missing_result") pending.add(issue.toolCallId);
			}
		}
		return evaluateCompactionBarrier(capture.report, [...pending]);
	}

	repairEmergencyTail(capture: CapturedCompactionState): {
		readonly capture: CapturedCompactionState;
		readonly repairedToolCallIds: ReadonlySet<string>;
	} {
		const { sessionManager } = this.deps;
		const barrier = this.evaluateBarrier(capture, true);
		if (barrier.status !== "defer" || barrier.reason !== "missing_active_tail_results") {
			if (barrier.status !== "ready") throw this.barrierError(barrier);
			return { capture, repairedToolCallIds: new Set() };
		}
		const repairedMessages = repairTranscriptIntegrity(
			[...capture.report.activeMessages],
			"Tool result missing; synthesized to close an emergency compaction barrier",
		);
		const inserted = repairedMessages.slice(capture.report.activeMessages.length);
		const repairedToolCallIds = new Set<string>();
		for (const message of inserted) {
			if (message.role !== "toolResult") {
				throw new Error("Emergency compaction repair produced a non-tool result");
			}
			const toolResult: ToolResultMessage = message;
			repairedToolCallIds.add(toolResult.toolCallId);
			sessionManager.appendMessage(toolResult);
		}
		sessionManager.appendCustomEntry("compaction_transcript_repaired", {
			insertedToolCallIds: [...repairedToolCallIds],
			reason: "emergency_compaction",
		});
		this.deps.invalidateContextBudget();
		const closedCapture = this.captureState();
		const closedBarrier = this.evaluateBarrier(closedCapture, false, repairedToolCallIds);
		if (closedBarrier.status !== "ready") throw this.barrierError(closedBarrier);
		this.deps.refreshAgentMessages();
		return { capture: closedCapture, repairedToolCallIds };
	}

	priorCommittedSourceDigests(): string[] {
		const digests: string[] = [];
		for (const entry of this.deps.sessionManager.getEntries()) {
			if (entry.type !== "compaction" || typeof entry.details !== "object" || entry.details === null) continue;
			if (!Object.hasOwn(entry.details, "compactionEnvelope")) continue;
			const envelope = validateCompactionEnvelope(Reflect.get(entry.details, "compactionEnvelope"));
			if (envelope.summary !== entry.summary) {
				throw new Error(`Compaction entry ${entry.id} has invalid provenance. Run the session doctor.`);
			}
			digests.push(envelope.source.sourceSha256);
		}
		return digests;
	}

	beginTransaction(compactionModel: Model<Api>, emergency: boolean): BegunCompaction {
		let capture = this.captureState();
		if (emergency) {
			capture = this.repairEmergencyTail(capture).capture;
		} else {
			const barrier = this.evaluateBarrier(capture, false);
			if (barrier.status !== "ready") throw this.barrierError(barrier);
		}
		const transaction = createCompactionTransaction({
			transactionId: randomUUID(),
			baseRevision: capture.revision,
			source: capture.source,
			createdAt: new Date().toISOString(),
			model: { provider: compactionModel.provider, id: compactionModel.id },
			preserved: this.captureProvenance(capture),
		});
		if (this.priorCommittedSourceDigests().includes(transaction.source.sourceSha256)) {
			throw new Error("This exact compaction source was already compacted");
		}
		return { capture, transaction };
	}

	captureProvenance(capture: CapturedCompactionState): CompactionPreservedProvenanceInput {
		let latestIntent = "Continue the current session";
		for (let index = capture.report.activeMessages.length - 1; index >= 0; index -= 1) {
			const message = capture.report.activeMessages[index];
			if (message?.role !== "user") continue;
			const candidate = sanitizeBinaryOutput(redactSensitiveText(this.deps.getUserMessageText(message)).trim())
				.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
				.slice(0, 16_384);
			if (candidate.length > 0) latestIntent = candidate;
			break;
		}
		const modelHistory = capture.branchEntries
			.flatMap((entry) => {
				if (entry.type === "model_change") {
					return [{ entryId: entry.id, provider: entry.provider, modelId: entry.modelId }];
				}
				if (entry.type === "message" && entry.message.role === "assistant") {
					return [{ entryId: entry.id, provider: entry.message.provider, modelId: entry.message.model }];
				}
				return [];
			})
			.slice(-256);
		const customEntryIds = (customType: string): string[] =>
			capture.branchEntries
				.filter((entry) => entry.type === "custom" && entry.customType === customType)
				.map((entry) => entry.id);
		return {
			latestIntent,
			openTasks: [],
			laneIds: customEntryIds("lane"),
			acceptancePredicateIds: customEntryIds("acceptance_predicate"),
			evidenceReceiptIds: customEntryIds("evidence_receipt"),
			blockerReasons: [],
			repairEventIds: [
				...customEntryIds("transcript_repaired"),
				...customEntryIds("compaction_transcript_repaired"),
			],
			branch: null,
			worktree: this.deps.cwd,
			modelHistory,
			nextAction: latestIntent.slice(0, 4096) || "Continue the current session",
		};
	}

	detailsWithEnvelope(details: unknown, envelope: CompactionEnvelope): unknown {
		if (typeof details === "object" && details !== null && !Array.isArray(details)) {
			return { ...details, compactionEnvelope: envelope };
		}
		return {
			compactionEnvelope: envelope,
			...(details === undefined ? {} : { resultDetails: details }),
		};
	}

	commit(begun: BegunCompaction, result: CompactionResult, fromExtension: boolean): CommittedCompaction {
		if (!begun.transaction.source.entryIds.includes(result.firstKeptEntryId)) {
			throw new Error("Compaction first-kept entry is outside the captured source");
		}
		const committed = this.deps.sessionManager.withCompactionCommitLock(() => {
			const current = this.captureState();
			const barrier = this.evaluateBarrier(current, false);
			const decision = decideCompactionCommit({
				transaction: begun.transaction,
				currentRevision: current.revision,
				currentSource: current.source,
				barrier,
				priorCommittedSourceDigests: this.priorCommittedSourceDigests(),
			});
			switch (decision.decision) {
				case "duplicate":
					throw new Error("This exact compaction source was already compacted");
				case "stale":
					throw new Error(
						`Session changed during compaction (${decision.reason}); generated summary was discarded`,
					);
				case "defer":
				case "fail_closed":
					throw this.barrierError(barrier);
				case "commit": {
					const envelope = createCompactionEnvelope({
						transaction: begun.transaction,
						decision,
						summary: result.summary,
						summarySha256: createHash("sha256").update(result.summary, "utf8").digest("hex"),
					});
					const entryId = this.deps.sessionManager.appendCompaction(
						result.summary,
						result.firstKeptEntryId,
						result.tokensBefore,
						this.detailsWithEnvelope(result.details, envelope),
						fromExtension,
					);
					const entry = this.deps.sessionManager.getEntry(entryId);
					if (!entry || entry.type !== "compaction") {
						throw new Error("Compaction commit did not produce a compaction entry");
					}
					return { entry, envelope };
				}
			}
		});
		this.deps.recordCommit();
		return committed;
	}
}
