import { describe, expect, it, vi } from "vitest";
import * as currentAgentCore from "../../agent/src/index.ts";
import {
	type CompactionBarrierResult,
	type CompactionCommitDecision,
	createCompactionEnvelope,
	createCompactionSourceIdentity,
	createCompactionTransaction,
	createSessionRevisionToken,
	decideCompactionCommit,
	evaluateCompactionBarrier,
} from "../src/core/compaction/transaction.ts";

vi.mock("omk-agent-core", () => currentAgentCore);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validSessionId() {
	return "sess_test-001";
}
function validId(prefix = "entry") {
	return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
function validSha256() {
	return "a".repeat(64);
}
function emptySha256() {
	return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
}
function validSummarySha256() {
	return "b".repeat(64);
}

function minimalRevisionToken(overrides: Record<string, unknown> = {}) {
	return createSessionRevisionToken({
		sessionId: validSessionId(),
		completeBytes: 100,
		recordCount: 3,
		leafId: validId(),
		lastEntryId: validId(),
		completePrefixSha256: validSha256(),
		...overrides,
	});
}

function minimalSourceIdentity(overrides: Record<string, unknown> = {}) {
	// Build entryIds consistent with first/last IDs, respecting overrides.
	const lastId = (overrides.lastEntryId as string) ?? (overrides.activeLeafId as string) ?? validId("e3");
	const firstId = (overrides.firstEntryId as string) ?? validId("e1");
	const midId = validId("e2");
	const entryIds = [firstId, midId, lastId];
	const input: Record<string, unknown> = {
		sessionId: validSessionId(),
		entryIds,
		firstEntryId: firstId,
		lastEntryId: lastId,
		sourceSha256: validSha256(),
		activeLeafId: lastId,
		messageCount: 2,
	};
	Object.assign(input, overrides);
	return createCompactionSourceIdentity(input as never);
}

function minimalTransaction(overrides: Record<string, unknown> = {}) {
	const rev = minimalRevisionToken();
	const leafId = rev.leafId!;
	// Build source with matching IDs from scratch to keep entryIds consistent
	const src = minimalSourceIdentity({
		sessionId: rev.sessionId,
		activeLeafId: leafId,
		lastEntryId: leafId,
	});
	return createCompactionTransaction({
		transactionId: validId("txn"),
		baseRevision: rev,
		source: src,
		createdAt: "2024-01-15T10:30:00.000Z",
		model: { provider: "test", id: "model-1" },
		preserved: {
			latestIntent: "test intent",
			openTasks: [],
			laneIds: [],
			acceptancePredicateIds: [],
			evidenceReceiptIds: [],
			blockerReasons: [],
			repairEventIds: [],
			branch: null,
			worktree: null,
			modelHistory: [],
			nextAction: "continue",
		},
		...overrides,
	});
}

/** Build a bare-minimum consistent SessionIntegrityReport suitable for barrier testing. */
function consistentReport(overrides: Record<string, unknown> = {}) {
	// We construct inline because SessionIntegrityReport is not a simple POJO.
	// The barrier only inspects fields validated by reportIsConsistent.
	const e1 = { id: validId("e"), parentId: null, role: "user" as const, content: [], timestamp: 1 };
	const e2 = { id: validId("e"), parentId: e1.id, role: "assistant" as const, content: [], timestamp: 2 };
	const e3 = { id: validId("e"), parentId: e2.id, role: "user" as const, content: [], timestamp: 3 };
	return {
		ok: true,
		source: { byteCount: 100, sha256: validSha256() },
		completePrefix: { byteCount: 100, sha256: validSha256(), lineCount: 3 },
		trailingFragment: null,
		header: {
			id: validId("hdr"),
			type: "session" as const,
			version: 3,
			timestamp: "2024-01-15T10:30:00.000Z",
			cwd: "/tmp",
		},
		entries: [e1, e2, e3],
		activeLeafId: e3.id,
		activeBranch: [e1, e2, e3],
		activeMessages: [],
		transcript: { ok: true, issues: [] },
		findings: [],
		...overrides,
	} as unknown as Parameters<typeof evaluateCompactionBarrier>[0];
}

// ---------------------------------------------------------------------------
// SessionRevisionToken constructor tests
// ---------------------------------------------------------------------------

describe("createSessionRevisionToken", () => {
	it("creates a frozen token from valid input", () => {
		const token = minimalRevisionToken();
		expect(Object.isFrozen(token)).toBe(true);
		expect(token.schemaVersion).toBe(1);
	});

	it("rejects non-object input", () => {
		expect(() => createSessionRevisionToken(null as never)).toThrow(TypeError);
		expect(() => createSessionRevisionToken("bad" as never)).toThrow(TypeError);
	});

	it("rejects extra keys", () => {
		expect(() =>
			createSessionRevisionToken({
				sessionId: validSessionId(),
				completeBytes: 0,
				recordCount: 0,
				leafId: null,
				lastEntryId: null,
				completePrefixSha256: emptySha256(),
				extraKey: "nope",
			} as never),
		).toThrow(TypeError);
	});

	it("rejects empty revision with non-null entry ids", () => {
		expect(() =>
			createSessionRevisionToken({
				sessionId: validSessionId(),
				completeBytes: 0,
				recordCount: 0,
				leafId: validId(),
				lastEntryId: null,
				completePrefixSha256: emptySha256(),
			}),
		).toThrow(TypeError);
	});

	it("rejects leafId without lastEntryId", () => {
		expect(() =>
			createSessionRevisionToken({
				sessionId: validSessionId(),
				completeBytes: 100,
				recordCount: 1,
				leafId: validId(),
				lastEntryId: null,
				completePrefixSha256: validSha256(),
			}),
		).toThrow(TypeError);
	});

	it("rejects empty revision with invalid sha256", () => {
		expect(() =>
			createSessionRevisionToken({
				sessionId: validSessionId(),
				completeBytes: 0,
				recordCount: 0,
				leafId: null,
				lastEntryId: null,
				completePrefixSha256: validSha256(), // should be empty sha
			}),
		).toThrow(TypeError);
	});

	it("rejects mismatched completeBytes/recordCount emptiness", () => {
		expect(() =>
			createSessionRevisionToken({
				sessionId: validSessionId(),
				completeBytes: 0,
				recordCount: 5,
				leafId: null,
				lastEntryId: null,
				completePrefixSha256: emptySha256(),
			}),
		).toThrow(TypeError);
		expect(() =>
			createSessionRevisionToken({
				sessionId: validSessionId(),
				completeBytes: 100,
				recordCount: 0,
				leafId: null,
				lastEntryId: null,
				completePrefixSha256: validSha256(),
			}),
		).toThrow(TypeError);
	});

	it("accepts optional fileIdentity", () => {
		const token = createSessionRevisionToken({
			sessionId: validSessionId(),
			completeBytes: 100,
			recordCount: 1,
			leafId: validId(),
			lastEntryId: validId(),
			completePrefixSha256: validSha256(),
			fileIdentity: { dev: "2049", ino: "12345" },
		});
		expect(token.fileIdentity).toEqual({ dev: "2049", ino: "12345" });
		expect(Object.isFrozen(token.fileIdentity!)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// CompactionSourceIdentity constructor tests
// ---------------------------------------------------------------------------

describe("createCompactionSourceIdentity", () => {
	it("creates a frozen source with matching endpoints", () => {
		const src = minimalSourceIdentity();
		expect(Object.isFrozen(src)).toBe(true);
		expect(src.firstEntryId).toBe(src.entryIds[0]);
		expect(src.lastEntryId).toBe(src.entryIds.at(-1));
	});

	it("rejects extra keys", () => {
		const e = validId();
		expect(() =>
			createCompactionSourceIdentity({
				sessionId: validSessionId(),
				entryIds: [e],
				firstEntryId: e,
				lastEntryId: e,
				sourceSha256: validSha256(),
				activeLeafId: e,
				messageCount: 1,
				extra: true,
			} as never),
		).toThrow(TypeError);
	});

	it("rejects empty entryIds", () => {
		expect(() =>
			createCompactionSourceIdentity({
				sessionId: validSessionId(),
				entryIds: [],
				firstEntryId: validId(),
				lastEntryId: validId(),
				sourceSha256: validSha256(),
				activeLeafId: validId(),
				messageCount: 0,
			}),
		).toThrow(TypeError);
	});

	it("rejects messageCount exceeding entryIds length", () => {
		const e = validId();
		expect(() =>
			createCompactionSourceIdentity({
				sessionId: validSessionId(),
				entryIds: [e],
				firstEntryId: e,
				lastEntryId: e,
				sourceSha256: validSha256(),
				activeLeafId: e,
				messageCount: 999,
			}),
		).toThrow(TypeError);
	});

	it("rejects mismatched firstEntryId", () => {
		const e1 = validId("a");
		const e2 = validId("b");
		expect(() =>
			createCompactionSourceIdentity({
				sessionId: validSessionId(),
				entryIds: [e1, e2],
				firstEntryId: e2, // swapped
				lastEntryId: e2,
				sourceSha256: validSha256(),
				activeLeafId: e2,
				messageCount: 1,
			}),
		).toThrow(TypeError);
	});

	it("rejects mismatched lastEntryId", () => {
		const e1 = validId("a");
		const e2 = validId("b");
		expect(() =>
			createCompactionSourceIdentity({
				sessionId: validSessionId(),
				entryIds: [e1, e2],
				firstEntryId: e1,
				lastEntryId: e1, // swapped
				sourceSha256: validSha256(),
				activeLeafId: e1,
				messageCount: 1,
			}),
		).toThrow(TypeError);
	});

	it("rejects activeLeafId !== lastEntryId (R30 P2)", () => {
		const e1 = validId("a");
		const e2 = validId("b");
		expect(() =>
			createCompactionSourceIdentity({
				sessionId: validSessionId(),
				entryIds: [e1, e2],
				firstEntryId: e1,
				lastEntryId: e2,
				sourceSha256: validSha256(),
				activeLeafId: e1, // does not match lastEntryId
				messageCount: 1,
			}),
		).toThrow(/activeLeafId must match/);
	});

	it("rejects duplicate entryIds", () => {
		const e = validId();
		expect(() =>
			createCompactionSourceIdentity({
				sessionId: validSessionId(),
				entryIds: [e, e],
				firstEntryId: e,
				lastEntryId: e,
				sourceSha256: validSha256(),
				activeLeafId: e,
				messageCount: 1,
			}),
		).toThrow(/unique/);
	});

	it("rejects large arrays", () => {
		const ids = Array.from({ length: 5000 }, (_) => validId());
		const first = ids[0]!;
		const last = ids.at(-1)!;
		expect(() =>
			createCompactionSourceIdentity({
				sessionId: validSessionId(),
				entryIds: ids,
				firstEntryId: first,
				lastEntryId: last,
				sourceSha256: validSha256(),
				activeLeafId: last,
				messageCount: 1,
			}),
		).toThrow(TypeError);
	});
});

// ---------------------------------------------------------------------------
// CompactionTransaction constructor tests
// ---------------------------------------------------------------------------

describe("createCompactionTransaction", () => {
	it("creates a frozen transaction with consistent revision/source", () => {
		const txn = minimalTransaction();
		expect(Object.isFrozen(txn)).toBe(true);
		expect(txn.baseRevision.sessionId).toBe(txn.source.sessionId);
		expect(txn.baseRevision.leafId).toBe(txn.source.activeLeafId);
		expect(txn.preserved.latestIntent).toBe("test intent");
	});

	it("rejects extra keys", () => {
		const txn = minimalTransaction();
		expect(() => createCompactionTransaction({ ...txn, extra: 1 } as never)).toThrow(/unsupported/);
	});

	it("rejects mismatched sessionId between revision and source", () => {
		const rev = minimalRevisionToken({ sessionId: "sess_A" });
		const src = minimalSourceIdentity({ sessionId: "sess_B", activeLeafId: rev.leafId, lastEntryId: rev.leafId });
		expect(() =>
			createCompactionTransaction({
				transactionId: validId("txn"),
				baseRevision: rev,
				source: src,
				createdAt: "2024-01-15T10:30:00.000Z",
				model: { provider: "test", id: "m" },
				preserved: {
					latestIntent: "test",
					openTasks: [],
					laneIds: [],
					acceptancePredicateIds: [],
					evidenceReceiptIds: [],
					blockerReasons: [],
					repairEventIds: [],
					branch: null,
					worktree: null,
					modelHistory: [],
					nextAction: "continue",
				},
			}),
		).toThrow(/same session/);
	});

	it("rejects non-canonical timestamps", () => {
		const txn = minimalTransaction();
		expect(() => createCompactionTransaction({ ...txn, createdAt: "2024-01-15 10:30:00" } as never)).toThrow(
			/canonical/,
		);
	});

	it("rejects credential-shaped latestIntent", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, latestIntent: "Bearer abc123def456ghi789" },
			} as never),
		).toThrow(/credential/);
	});

	it("rejects credential-shaped metadata in transactionId", () => {
		expect(() =>
			createCompactionTransaction({
				...minimalTransaction(),
				transactionId: "sk-abc123def456ghi789",
			} as never),
		).toThrow(/credential/);
	});

	it("rejects duplicate provenance IDs", () => {
		const txn = minimalTransaction();
		const dup = validId("dup");
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, evidenceReceiptIds: [dup, dup] },
			} as never),
		).toThrow(/unique/);
	});

	it("freezes nested arrays in the output", () => {
		const txn = minimalTransaction({
			preserved: {
				...minimalTransaction().preserved,
				evidenceReceiptIds: [validId()],
				laneIds: [validId()],
			},
		});
		expect(Object.isFrozen(txn.preserved.evidenceReceiptIds)).toBe(true);
		expect(Object.isFrozen(txn.preserved.laneIds)).toBe(true);
		expect(Object.isFrozen(txn.preserved.modelHistory)).toBe(true);
	});

	it("rejects missing preserved", () => {
		const txn = minimalTransaction();
		expect(() => createCompactionTransaction({ ...txn, preserved: undefined } as never)).toThrow(/preserved/);
	});

	it("rejects extra keys in preserved", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, extra: true } as never,
			} as never),
		).toThrow(/unsupported/);
	});

	it("rejects empty latestIntent", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, latestIntent: "" },
			} as never),
		).toThrow(/non-empty/);
	});

	it("rejects empty nextAction", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, nextAction: "" },
			} as never),
		).toThrow(/non-empty/);
	});

	it("allows empty openTasks and blockerReasons", () => {
		const txn = minimalTransaction({
			preserved: { ...minimalTransaction().preserved, openTasks: [], blockerReasons: [] },
		});
		expect(txn.preserved.openTasks).toEqual([]);
		expect(txn.preserved.blockerReasons).toEqual([]);
	});

	it("rejects duplicate laneIds", () => {
		const txn = minimalTransaction();
		const dup = validId("dup");
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, laneIds: [dup, dup] },
			} as never),
		).toThrow(/unique/);
	});

	it("rejects duplicate acceptancePredicateIds", () => {
		const txn = minimalTransaction();
		const dup = validId("dup");
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, acceptancePredicateIds: [dup, dup] },
			} as never),
		).toThrow(/unique/);
	});

	it("rejects duplicate repairEventIds", () => {
		const txn = minimalTransaction();
		const dup = validId("dup");
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, repairEventIds: [dup, dup] },
			} as never),
		).toThrow(/unique/);
	});

	it("rejects duplicate entryId in modelHistory", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: {
					...txn.preserved,
					modelHistory: [
						{ entryId: "m1", provider: "p", modelId: "x" },
						{ entryId: "m1", provider: "p", modelId: "y" },
					],
				},
			} as never),
		).toThrow(/unique entryId/);
	});

	it("rejects credential-shaped nextAction", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, nextAction: "Bearer abc123def456ghi789" },
			} as never),
		).toThrow(/credential/);
	});

	it("rejects control characters in openTasks", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, openTasks: ["task\x00"] },
			} as never),
		).toThrow(/control/);
	});

	it("rejects oversized blockerReasons", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, blockerReasons: ["x".repeat(10_000)] },
			} as never),
		).toThrow(/bounded/);
	});

	it("rejects credential-shaped branch", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: { ...txn.preserved, branch: "Bearer abc123def456ghi789" },
			} as never),
		).toThrow(/credential/);
	});

	it("rejects modelHistory with extra keys", () => {
		const txn = minimalTransaction();
		expect(() =>
			createCompactionTransaction({
				...txn,
				preserved: {
					...txn.preserved,
					modelHistory: [{ entryId: "m1", provider: "p", modelId: "x", extra: 1 } as never],
				},
			} as never),
		).toThrow(/unsupported/);
	});

	it("freezes preserved object and modelHistory records", () => {
		const txn = minimalTransaction({
			preserved: {
				...minimalTransaction().preserved,
				modelHistory: [{ entryId: "m1", provider: "p", modelId: "x" }],
			},
		});
		expect(Object.isFrozen(txn.preserved)).toBe(true);
		expect(Object.isFrozen(txn.preserved.modelHistory[0])).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Barrier tests
// ---------------------------------------------------------------------------

describe("evaluateCompactionBarrier", () => {
	it("returns ready for clean report with no pending", () => {
		const report = consistentReport();
		const result = evaluateCompactionBarrier(report, []);
		expect(result.status).toBe("ready");
		expect(result.reason).toBe("closed_active_branch");
		expect(result.pendingToolCallIds).toEqual([]);
		expect(result.missingToolCallIds).toEqual([]);
	});

	it("returns defer/pending_tool_calls when pending not empty and no missing", () => {
		const report = consistentReport();
		const tcId = validId("tc");
		const result = evaluateCompactionBarrier(report, [tcId]);
		expect(result.status).toBe("defer");
		expect(result.reason).toBe("pending_tool_calls");
		expect(result.pendingToolCallIds).toEqual([tcId]);
		expect(result.missingToolCallIds).toEqual([]);
	});

	it("returns defer/missing_active_tail_results for missing at active tail", () => {
		const tcId = validId("tc");
		const report = consistentReport({
			activeMessages: [{ role: "assistant", content: [{ type: "toolCall", id: tcId, name: "read" }], timestamp: 1 }],
			transcript: { ok: false, issues: [{ kind: "missing_result", toolCallId: tcId, toolName: "read" }] },
			findings: [{ reason: "transcript_missing_result", toolCallId: tcId, toolName: "read" }],
			ok: false,
		});
		const result = evaluateCompactionBarrier(report, [tcId]);
		expect(result.status).toBe("defer");
		expect(result.reason).toBe("missing_active_tail_results");
		expect(result.missingToolCallIds).toContain(tcId);
	});

	it("returns fail_closed/unsafe_missing_tool_results for missing not at active tail", () => {
		const tcId = validId("tc");
		// A missing result for a call that's NOT in the pending set
		const report = consistentReport({
			activeMessages: [{ role: "assistant", content: [{ type: "toolCall", id: tcId, name: "read" }], timestamp: 1 }],
			transcript: { ok: false, issues: [{ kind: "missing_result", toolCallId: tcId, toolName: "read" }] },
			findings: [{ reason: "transcript_missing_result", toolCallId: tcId, toolName: "read" }],
			ok: false,
		});
		// pending list does NOT include tcId
		const result = evaluateCompactionBarrier(report, []);
		expect(result.status).toBe("fail_closed");
		expect(result.reason).toBe("unsafe_missing_tool_results");
	});

	it("returns fail_closed/structural_integrity_failure for non-transcript finding with null transcript", () => {
		const report = consistentReport({
			transcript: null,
			findings: [{ reason: "missing_header" }],
			ok: false,
			header: null,
		});
		const result = evaluateCompactionBarrier(report, []);
		expect(result.status).toBe("fail_closed");
		expect(result.reason).toBe("structural_integrity_failure");
	});

	it("returns fail_closed/inconsistent_integrity_report for null transcript with non-empty activeMessages", () => {
		const tcId = validId("tc");
		const report = consistentReport({
			activeMessages: [{ role: "assistant", content: [{ type: "toolCall", id: tcId, name: "read" }], timestamp: 1 }],
			transcript: null,
			findings: [{ reason: "active_leaf_missing" }],
			ok: false,
		});
		const result = evaluateCompactionBarrier(report, []);
		expect(result.status).toBe("fail_closed");
		expect(result.reason).toBe("inconsistent_integrity_report");
	});

	it("returns fail_closed/inconsistent_integrity_report for null transcript without structural finding", () => {
		const report = consistentReport({
			transcript: null,
			findings: [],
			ok: true,
		});
		const result = evaluateCompactionBarrier(report, []);
		expect(result.status).toBe("fail_closed");
		expect(result.reason).toBe("inconsistent_integrity_report");
	});

	it("returns fail_closed/structural_integrity_failure for null transcript with structural finding and empty activeMessages (P1-2)", () => {
		const report = consistentReport({
			activeMessages: [],
			transcript: null,
			findings: [{ reason: "active_leaf_missing" }],
			ok: false,
		});
		const result = evaluateCompactionBarrier(report, []);
		expect(result.status).toBe("fail_closed");
		expect(result.reason).toBe("structural_integrity_failure");
		// Never returns "ready" for null transcript
		expect(result.status).not.toBe("ready");
	});

	it("returns fail_closed/invalid_pending_tool_ids for invalid pending input", () => {
		const report = consistentReport();
		const result = evaluateCompactionBarrier(report, null as never);
		expect(result.status).toBe("fail_closed");
		expect(result.reason).toBe("invalid_pending_tool_ids");
	});

	it("barrier result is always frozen", () => {
		const report = consistentReport();
		const result = evaluateCompactionBarrier(report, []);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.pendingToolCallIds)).toBe(true);
		expect(Object.isFrozen(result.missingToolCallIds)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Commit decision tests
// ---------------------------------------------------------------------------

describe("decideCompactionCommit", () => {
	function readyBarrier(): CompactionBarrierResult {
		return {
			status: "ready",
			reason: "closed_active_branch",
			pendingToolCallIds: Object.freeze([]),
			missingToolCallIds: Object.freeze([]),
		};
	}

	function deferBarrier(pending: string[] = []): CompactionBarrierResult {
		return {
			status: "defer",
			reason: pending.length > 0 ? "pending_tool_calls" : "missing_active_tail_results",
			pendingToolCallIds: Object.freeze([...pending]),
			missingToolCallIds: Object.freeze([]),
		};
	}

	function failBarrier(): CompactionBarrierResult {
		return {
			status: "fail_closed",
			reason: "inconsistent_integrity_report",
			pendingToolCallIds: Object.freeze([]),
			missingToolCallIds: Object.freeze([]),
		};
	}

	it("returns commit/exact_match when all match", () => {
		const txn = minimalTransaction();
		const decision = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: readyBarrier(),
			priorCommittedSourceDigests: [],
		});
		expect(decision.decision).toBe("commit");
		expect((decision as Extract<CompactionCommitDecision, { decision: "commit" }>).reason).toBe("exact_match");
	});

	it("returns stale/revision_mismatch when revision changed", () => {
		const txn = minimalTransaction();
		const changedRev = minimalRevisionToken({ completeBytes: 999, sessionId: txn.baseRevision.sessionId });
		const decision = decideCompactionCommit({
			transaction: txn,
			currentRevision: changedRev,
			currentSource: txn.source,
			barrier: readyBarrier(),
			priorCommittedSourceDigests: [],
		});
		expect(decision.decision).toBe("stale");
		expect((decision as Extract<CompactionCommitDecision, { decision: "stale" }>).reason).toBe("revision_mismatch");
	});

	it("returns stale/source_mismatch when source changed", () => {
		const txn = minimalTransaction();
		const changedSrc = minimalSourceIdentity({
			sessionId: txn.source.sessionId,
			activeLeafId: txn.source.activeLeafId,
			lastEntryId: txn.source.activeLeafId,
		});
		const decision = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: changedSrc,
			barrier: readyBarrier(),
			priorCommittedSourceDigests: [],
		});
		expect(decision.decision).toBe("stale");
		expect((decision as Extract<CompactionCommitDecision, { decision: "stale" }>).reason).toBe("source_mismatch");
	});

	it("returns duplicate/source_already_committed when digest already recorded", () => {
		const txn = minimalTransaction();
		const decision = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: readyBarrier(),
			priorCommittedSourceDigests: [txn.source.sourceSha256],
		});
		expect(decision.decision).toBe("duplicate");
	});

	it("duplicate check wins before stale check", () => {
		const txn = minimalTransaction();
		const changedRev = minimalRevisionToken({ completeBytes: 999, sessionId: txn.baseRevision.sessionId });
		const decision = decideCompactionCommit({
			transaction: txn,
			currentRevision: changedRev,
			currentSource: txn.source,
			barrier: readyBarrier(),
			priorCommittedSourceDigests: [txn.source.sourceSha256],
		});
		expect(decision.decision).toBe("duplicate");
	});

	it("returns defer/barrier_defer when barrier is defer", () => {
		const txn = minimalTransaction();
		const decision = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: deferBarrier([validId("tc")]),
			priorCommittedSourceDigests: [],
		});
		expect(decision.decision).toBe("defer");
	});

	it("returns fail_closed/barrier_fail_closed when barrier fails closed", () => {
		const txn = minimalTransaction();
		const decision = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: failBarrier(),
			priorCommittedSourceDigests: [],
		});
		expect(decision.decision).toBe("fail_closed");
		expect((decision as Extract<CompactionCommitDecision, { decision: "fail_closed" }>).reason).toBe(
			"barrier_fail_closed",
		);
	});

	it("returns fail_closed/invalid_commit_input for forged barrier shape (P1-3)", () => {
		const txn = minimalTransaction();
		// ready barrier with non-empty arrays is invalid
		const forgedBarrier: CompactionBarrierResult = {
			status: "ready",
			reason: "closed_active_branch",
			pendingToolCallIds: Object.freeze([validId("tc")]),
			missingToolCallIds: Object.freeze([]),
		};
		const decision = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: forgedBarrier,
			priorCommittedSourceDigests: [],
		});
		expect(decision.decision).toBe("fail_closed");
		expect((decision as Extract<CompactionCommitDecision, { decision: "fail_closed" }>).reason).toBe(
			"invalid_commit_input",
		);
	});

	it("returns fail_closed/invalid_commit_input for defer without pending (P1-3)", () => {
		const txn = minimalTransaction();
		const forgedBarrier: CompactionBarrierResult = {
			status: "defer",
			reason: "pending_tool_calls",
			pendingToolCallIds: Object.freeze([]),
			missingToolCallIds: Object.freeze([]),
		};
		const decision = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: forgedBarrier,
			priorCommittedSourceDigests: [],
		});
		expect(decision.decision).toBe("fail_closed");
		expect((decision as Extract<CompactionCommitDecision, { decision: "fail_closed" }>).reason).toBe(
			"invalid_commit_input",
		);
	});

	it("returns fail_closed/invalid_transaction for invalid transaction input", () => {
		const decision = decideCompactionCommit({
			transaction: null as never,
			currentRevision: minimalRevisionToken(),
			currentSource: minimalSourceIdentity(),
			barrier: readyBarrier(),
			priorCommittedSourceDigests: [],
		});
		expect(decision.decision).toBe("fail_closed");
		expect((decision as Extract<CompactionCommitDecision, { decision: "fail_closed" }>).reason).toBe(
			"invalid_transaction",
		);
	});

	it("all decision shapes are frozen", () => {
		const txn = minimalTransaction();
		for (const barrier of [readyBarrier(), deferBarrier(), failBarrier()]) {
			const decision = decideCompactionCommit({
				transaction: txn,
				currentRevision: txn.baseRevision,
				currentSource: txn.source,
				barrier,
				priorCommittedSourceDigests: [],
			});
			expect(Object.isFrozen(decision)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Envelope tests
// ---------------------------------------------------------------------------

describe("createCompactionEnvelope", () => {
	it("creates a frozen envelope from a commit decision", () => {
		const txn = minimalTransaction();
		const decision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: txn.baseRevision,
			source: txn.source,
		};
		const summarySha256 = validSummarySha256();
		const envelope = createCompactionEnvelope({ transaction: txn, decision, summary: "Test summary", summarySha256 });
		expect(Object.isFrozen(envelope)).toBe(true);
		expect(envelope.schemaVersion).toBe(2);
		expect(envelope.summary).toBe("Test summary");
		expect(envelope.summarySha256).toBe(summarySha256);
		expect(envelope.transactionId).toBe(txn.transactionId);
		expect(envelope.preserved.latestIntent).toBe(txn.preserved.latestIntent);
		expect(envelope.preserved.nextAction).toBe(txn.preserved.nextAction);
	});

	it("rejects non-commit decision", () => {
		const txn = minimalTransaction();
		const staleDecision: CompactionCommitDecision = {
			decision: "stale",
			reason: "revision_mismatch",
			transactionId: txn.transactionId,
		};
		expect(() =>
			createCompactionEnvelope({
				transaction: txn,
				decision: staleDecision,
				summary: "x",
				summarySha256: validSummarySha256(),
			}),
		).toThrow(/commit decision is required/);
	});

	it("rejects decision with mismatched transactionId", () => {
		const txn = minimalTransaction();
		const badDecision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: "wrong-id",
			revision: txn.baseRevision,
			source: txn.source,
		};
		expect(() =>
			createCompactionEnvelope({
				transaction: txn,
				decision: badDecision,
				summary: "x",
				summarySha256: validSummarySha256(),
			}),
		).toThrow(/does not match/);
	});

	it("rejects decision with mismatched revision", () => {
		const txn = minimalTransaction();
		const changedRev = minimalRevisionToken({
			completeBytes: 0,
			recordCount: 0,
			leafId: null,
			lastEntryId: null,
			completePrefixSha256: emptySha256(),
		});
		const badDecision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: changedRev,
			source: txn.source,
		};
		expect(() =>
			createCompactionEnvelope({
				transaction: txn,
				decision: badDecision,
				summary: "x",
				summarySha256: validSummarySha256(),
			}),
		).toThrow(/does not match/);
	});

	it("rejects credential-shaped summary", () => {
		const txn = minimalTransaction();
		const decision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: txn.baseRevision,
			source: txn.source,
		};
		expect(() =>
			createCompactionEnvelope({
				transaction: txn,
				decision,
				summary: 'api_key = "abc123"',
				summarySha256: validSummarySha256(),
			}),
		).toThrow(/credential/);
	});

	it("accepts a redacted credential placeholder in a summary", () => {
		const txn = minimalTransaction();
		const decision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: txn.baseRevision,
			source: txn.source,
		};
		const summary = 'api_key = "[REDACTED]"';

		const envelope = createCompactionEnvelope({
			transaction: txn,
			decision,
			summary,
			summarySha256: validSummarySha256(),
		});

		expect(envelope.summary).toBe(summary);
	});

	it("rejects text appended to a redacted credential placeholder", () => {
		const txn = minimalTransaction();
		const decision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: txn.baseRevision,
			source: txn.source,
		};
		for (const summary of ['api_key = "[REDACTED]"synthetic', "api_key = [REDACTED]-synthetic"]) {
			expect(() =>
				createCompactionEnvelope({
					transaction: txn,
					decision,
					summary,
					summarySha256: validSummarySha256(),
				}),
			).toThrow(/credential/);
		}
	});

	it("rejects oversized summary", () => {
		const txn = minimalTransaction();
		const decision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: txn.baseRevision,
			source: txn.source,
		};
		expect(() =>
			createCompactionEnvelope({
				transaction: txn,
				decision,
				summary: "x".repeat(300_000),
				summarySha256: validSummarySha256(),
			}),
		).toThrow(/bounded/);
	});

	it("rejects invalid summarySha256 digest", () => {
		const txn = minimalTransaction();
		const decision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: txn.baseRevision,
			source: txn.source,
		};
		expect(() =>
			createCompactionEnvelope({ transaction: txn, decision, summary: "ok", summarySha256: "not-a-digest" }),
		).toThrow(/lowercase 64-hex/);
		expect(() =>
			createCompactionEnvelope({
				transaction: txn,
				decision,
				summary: "ok",
				summarySha256: "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKL",
			}),
		).toThrow(/lowercase 64-hex/);
		expect(() =>
			createCompactionEnvelope({ transaction: txn, decision, summary: "ok", summarySha256: "cc".repeat(31) }),
		).toThrow(/lowercase 64-hex/);
	});

	it("rejects extra keys in input", () => {
		const txn = minimalTransaction();
		const decision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: txn.baseRevision,
			source: txn.source,
		};
		expect(() =>
			createCompactionEnvelope({
				transaction: txn,
				decision,
				summary: "ok",
				summarySha256: validSummarySha256(),
				extra: 1,
			} as never),
		).toThrow(/unsupported/);
	});

	it("freezes nested arrays in envelope", () => {
		const txn = minimalTransaction({
			preserved: {
				...minimalTransaction().preserved,
				evidenceReceiptIds: [validId()],
				laneIds: [validId()],
				repairEventIds: [validId()],
			},
		});
		const decision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: txn.baseRevision,
			source: txn.source,
		};
		const envelope = createCompactionEnvelope({
			transaction: txn,
			decision,
			summary: "ok",
			summarySha256: validSummarySha256(),
		});
		expect(Object.isFrozen(envelope.preserved.evidenceReceiptIds)).toBe(true);
		expect(Object.isFrozen(envelope.preserved.laneIds)).toBe(true);
		expect(Object.isFrozen(envelope.preserved.repairEventIds)).toBe(true);
		expect(Object.isFrozen(envelope.preserved)).toBe(true);
	});

	it("preserves complete provenance in envelope", () => {
		const txn = minimalTransaction({
			preserved: {
				...minimalTransaction().preserved,
				latestIntent: "compress context",
				openTasks: ["finish compression"],
				laneIds: ["lane-1"],
				acceptancePredicateIds: ["p1"],
				evidenceReceiptIds: ["r1"],
				blockerReasons: ["none"],
				repairEventIds: ["repair-1"],
				branch: "main",
				worktree: "/workspace",
				modelHistory: [{ entryId: "mh1", provider: "openai", modelId: "gpt-4" }],
				nextAction: "resume session",
			},
		});
		const decision: CompactionCommitDecision = {
			decision: "commit",
			reason: "exact_match",
			transactionId: txn.transactionId,
			revision: txn.baseRevision,
			source: txn.source,
		};
		const envelope = createCompactionEnvelope({
			transaction: txn,
			decision,
			summary: "ok",
			summarySha256: validSummarySha256(),
		});
		expect(envelope.preserved.latestIntent).toBe("compress context");
		expect(envelope.preserved.openTasks).toEqual(["finish compression"]);
		expect(envelope.preserved.laneIds).toEqual(["lane-1"]);
		expect(envelope.preserved.acceptancePredicateIds).toEqual(["p1"]);
		expect(envelope.preserved.evidenceReceiptIds).toEqual(["r1"]);
		expect(envelope.preserved.blockerReasons).toEqual(["none"]);
		expect(envelope.preserved.repairEventIds).toEqual(["repair-1"]);
		expect(envelope.preserved.branch).toBe("main");
		expect(envelope.preserved.worktree).toBe("/workspace");
		expect(envelope.preserved.modelHistory).toEqual([{ entryId: "mh1", provider: "openai", modelId: "gpt-4" }]);
		expect(envelope.preserved.nextAction).toBe("resume session");
	});
});

// ---------------------------------------------------------------------------
// P1-3: Strict barrier validation edge cases
// ---------------------------------------------------------------------------

describe("validBarrierResult integration via decideCompactionCommit", () => {
	const VALID_ID = "tc_valid_001";

	function barrier(overrides: Partial<CompactionBarrierResult>): CompactionBarrierResult {
		return {
			status: "ready",
			reason: "closed_active_branch",
			pendingToolCallIds: Object.freeze([]),
			missingToolCallIds: Object.freeze([]),
			...overrides,
		};
	}

	it("rejects defer/missing with missing not subset of pending", () => {
		const b = barrier({
			status: "defer",
			reason: "missing_active_tail_results",
			pendingToolCallIds: Object.freeze(["a"]),
			missingToolCallIds: Object.freeze(["b"]), // 'b' not in pending
		});
		const txn = minimalTransaction();
		const d = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: b,
			priorCommittedSourceDigests: [],
		});
		expect(d.decision).toBe("fail_closed");
		expect((d as Extract<CompactionCommitDecision, { decision: "fail_closed" }>).reason).toBe("invalid_commit_input");
	});

	it("rejects barrier with duplicate IDs in pending", () => {
		const b = barrier({
			status: "defer",
			reason: "pending_tool_calls",
			pendingToolCallIds: Object.freeze([VALID_ID, VALID_ID]),
			missingToolCallIds: Object.freeze([]),
		});
		const txn = minimalTransaction();
		const d = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: b,
			priorCommittedSourceDigests: [],
		});
		expect(d.decision).toBe("fail_closed");
	});

	it("rejects barrier with oversized pending array", () => {
		const ids = Array.from({ length: 2000 }, (_) => validId());
		const b = barrier({
			status: "defer",
			reason: "pending_tool_calls",
			pendingToolCallIds: Object.freeze(ids),
			missingToolCallIds: Object.freeze([]),
		});
		const txn = minimalTransaction();
		const d = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: b,
			priorCommittedSourceDigests: [],
		});
		expect(d.decision).toBe("fail_closed");
	});

	it("rejects barrier with invalid toolCallId containing control characters", () => {
		const b = barrier({
			status: "defer",
			reason: "pending_tool_calls",
			pendingToolCallIds: Object.freeze(["\x00invalid"]),
			missingToolCallIds: Object.freeze([]),
		});
		const txn = minimalTransaction();
		const d = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: b,
			priorCommittedSourceDigests: [],
		});
		expect(d.decision).toBe("fail_closed");
	});
});

// ---------------------------------------------------------------------------
// P2: Credential pattern hardening (Authorization:Bearer et al)
// ---------------------------------------------------------------------------

describe("credential shape rejection", () => {
	it("rejects Authorization:Bearer header in metadata", () => {
		expect(() =>
			createCompactionTransaction({
				...minimalTransaction(),
				transactionId: "Authorization:Bearer abc123def456ghi789",
			} as never),
		).toThrow(/credential/);
	});

	it("rejects Bearer with capital B in metadata", () => {
		expect(() =>
			createCompactionTransaction({
				...minimalTransaction(),
				transactionId: "Bearer abc123def456ghi789",
			} as never),
		).toThrow(/credential/);
	});

	it("rejects short quoted credential in metadata", () => {
		expect(() =>
			createCompactionTransaction({
				...minimalTransaction(),
				transactionId: 'password = "abc"',
			} as never),
		).toThrow(/credential/);
	});

	it("rejects secret_key pattern in metadata", () => {
		expect(() =>
			createCompactionTransaction({
				...minimalTransaction(),
				transactionId: "secret_key = abc123def",
			} as never),
		).toThrow(/credential/);
	});
});
