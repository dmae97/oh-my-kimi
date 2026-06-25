// [DEPRECATED — DEAD CODE] OMK v6.2 — Context Compactor (TypeScript)
// ==================================================================
// packages/coding-agent/src/core/compactor.ts
//
// STATUS: DEAD CODE — Not imported by any module at runtime.
// This file is NOT wired into AgentSession or any active pipeline.
//
// WHY DEAD:
//   - agent-session.ts imports CompactionResult from compaction/index.ts,
//     NOT from this file. The CompactionResult interfaces are different.
//   - No other file in src/ imports from compactor.ts.
//   - All classes (SlidingWindowCompactor, SemanticDeduplicator,
//     ImportanceScorer, ContextCompactor) are only referenced within this file.
//
// ACTUAL COMPACTION SYSTEM:
//   - compaction/compaction.ts  → real compaction with LLM summarization
//   - compaction/branch-summarization.ts → branch-specific summarization
//   - compaction/utils.ts → compaction utilities
//   - agent-session.ts imports compact(), prepareCompaction(), shouldCompact()
//     from compaction/index.ts
//
// NOTE: types/jailbreak.ts also defines a CompactionResult interface (different shape).
// Both are distinct from the real CompactionResult in compaction/compaction.ts.
//
// DO NOT MODIFY — preserved for reference only.

import { EventEmitter } from "events";

export interface CompactionTurn {
	index: number;
	role: string;
	content: string;
	timestamp: number;
	importance?: number;
}

export interface CompactionResult {
	preserved: CompactionTurn[];
	summarized: CompactionTurn[];
	summary: string;
	originalCount: number;
	finalCount: number;
	compressionRatio: number;
}

export class SlidingWindowCompactor extends EventEmitter {
	private windowSize: number;

	constructor(windowSize = 10) {
		super();
		this.windowSize = windowSize;
	}

	compact(turns: CompactionTurn[]): { preserved: CompactionTurn[]; evicted: CompactionTurn[] } {
		if (turns.length <= this.windowSize) {
			return { preserved: turns, evicted: [] };
		}
		return {
			preserved: turns.slice(-this.windowSize),
			evicted: turns.slice(0, -this.windowSize),
		};
	}
}

export class SemanticDeduplicator extends EventEmitter {
	deduplicate(turns: CompactionTurn[]): CompactionTurn[] {
		const seen = new Set<string>();
		const unique: CompactionTurn[] = [];

		for (const turn of turns) {
			const key = this.normalize(turn.content);
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(turn);
			}
		}

		return unique;
	}

	private normalize(text: string): string {
		return text.toLowerCase().replace(/\s+/g, " ").trim().substring(0, 100);
	}
}

export class ImportanceScorer extends EventEmitter {
	private keywords = ["refusal", "error", "strategy", "phase", "decision", "goal"];

	score(turn: CompactionTurn): number {
		let score = 0;
		const content = turn.content.toLowerCase();

		for (const kw of this.keywords) {
			if (content.includes(kw)) score += 2;
		}

		if (turn.role === "system") score += 1;
		if (turn.role === "assistant" && content.includes("refuse")) score += 5;

		return score;
	}
}

export class ContextCompactor extends EventEmitter {
	private slidingWindow: SlidingWindowCompactor;
	private deduplicator: SemanticDeduplicator;
	private scorer: ImportanceScorer;

	constructor(windowSize = 10) {
		super();
		this.slidingWindow = new SlidingWindowCompactor(windowSize);
		this.deduplicator = new SemanticDeduplicator();
		this.scorer = new ImportanceScorer();
	}

	compact(turns: CompactionTurn[], _level: "gentle" | "moderate" | "aggressive" = "moderate"): CompactionResult {
		const originalCount = turns.length;

		// 1. Importance scoring
		const scored = turns.map((t) => ({ ...t, importance: this.scorer.score(t) }));

		// 2. Protect high-importance turns
		const protectedTurns = scored.filter((t) => (t.importance ?? 0) >= 3);
		const candidates = scored.filter((t) => (t.importance ?? 0) < 3);

		// 3. Sliding window
		const { preserved, evicted } = this.slidingWindow.compact(candidates);

		// 4. Deduplicate evicted
		const uniqueEvicted = this.deduplicator.deduplicate(evicted);

		// 5. Summarize evicted
		const summary = this.summarize(uniqueEvicted);

		// 6. Assemble result
		const finalTurns = [...protectedTurns, ...preserved];
		if (summary) {
			finalTurns.push({
				index: -1,
				role: "system",
				content: `[Summary]: ${summary}`,
				timestamp: Date.now(),
			});
		}

		return {
			preserved: protectedTurns,
			summarized: uniqueEvicted,
			summary,
			originalCount,
			finalCount: finalTurns.length,
			compressionRatio: finalTurns.length / originalCount,
		};
	}

	private summarize(turns: CompactionTurn[]): string {
		if (turns.length === 0) return "";
		const topics = new Set<string>();
		for (const turn of turns) {
			const words = turn.content.split(/\s+/).filter((w) => w.length > 4);
			for (const w of words.slice(0, 3)) topics.add(w);
		}
		return `Topics: ${Array.from(topics).slice(0, 5).join(", ")}`;
	}
}

export default ContextCompactor;
