// OMK v6.2 — Lean CTX Engine (TypeScript)
// =========================================
// packages/coding-agent/src/core/lean-ctx.ts
//
// 매 프롬프트 입력 시 자동으로 context 분석/압축을 수행하는 엔진.
// 순수 로컬 모드 — API 호출 0회.

import { EventEmitter } from "events";

// ── 상수 및 설정 ────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
	recencyWindow: 4,
	relevanceThreshold: 0.3,
	keyTurnReserve: 2,
	summaryEvery: 3,
	maxContextTokens: 2000,
	compressionTarget: 0.6,

	tfidfWeight: 0.5,
	semanticWeight: 0.3,
	recencyWeight: 0.2,
	keywordBoost: 1.5,

	lruWeight: 0.4,
	frequencyWeight: 0.3,
	recencyDecayWeight: 0.3,
	protectedKeywords: ["refusal", "error", "strategy_change", "phase_transition"],

	hardTokenLimit: 15000,
	softTokenLimit: 12000,
	warningThreshold: 0.8,
	criticalThreshold: 0.95,
	gracefulDegradation: true,
	opportunisticExpansion: true,

	autoCompress: true,
	compressOnEveryPrompt: true,
	minTokensToCompress: 500,
	maxTurnsBeforeCompress: 8,
};

// ── 데이터 모델 ─────────────────────────────────────────────────────────

export interface TurnEntry {
	index: number;
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	timestamp: number;
	metadata?: Record<string, any>;
	tokenCount?: number;
	isKeyTurn?: boolean;
	relevanceScore?: number;
	accessCount?: number;
	lastAccessed?: number;
}

export interface CompressedContext {
	turns: TurnEntry[];
	summary: string;
	originalTokens: number;
	compressedTokens: number;
	compressionRatio: number;
	techniqueUsed: string;
	keyTurnsPreserved: number;
	evictedCount: number;
	metadata?: Record<string, any>;
}

export interface BudgetStatus {
	usedTokens: number;
	totalTokens: number;
	ratio: number;
	level: "green" | "yellow" | "orange" | "red" | "exceeded";
	remaining: number;
	canAddAgents: boolean;
}

// ── ContextCompressor ───────────────────────────────────────────────────

export class ContextCompressor extends EventEmitter {
	private config: typeof DEFAULT_CONFIG;
	private charsPerToken = 4;

	constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
		super();
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	compress(context: TurnEntry[], currentTurn?: TurnEntry): CompressedContext {
		const originalTokens = this.estimateTokens(context);

		if (originalTokens < this.config.minTokensToCompress) {
			return {
				turns: context,
				summary: "",
				originalTokens,
				compressedTokens: originalTokens,
				compressionRatio: 1.0,
				techniqueUsed: "none",
				keyTurnsPreserved: 0,
				evictedCount: 0,
			};
		}

		const keyTurns = this.extractKeyTurns(context);
		const recent = this.applyRecencyWindow(context);
		const relevant = this.filterByRelevance(context, currentTurn, keyTurns);
		const summary = this.hierarchicalSummarize(context, recent, keyTurns, relevant);
		const compressed = this.assembleCompressed(keyTurns, relevant, recent, summary);

		const compressedTokens = this.estimateTokens(compressed);
		const ratio = originalTokens > 0 ? compressedTokens / originalTokens : 1.0;

		return {
			turns: compressed,
			summary,
			originalTokens,
			compressedTokens,
			compressionRatio: ratio,
			techniqueUsed: "hierarchical+selective",
			keyTurnsPreserved: keyTurns.length,
			evictedCount: context.length - compressed.length,
		};
	}

	private estimateTokens(turns: TurnEntry[]): number {
		return turns.reduce((sum, t) => sum + Math.ceil(t.content.length / this.charsPerToken), 0);
	}

	private extractKeyTurns(context: TurnEntry[]): TurnEntry[] {
		const keyTurns: TurnEntry[] = [];
		const protectedKeywords = this.config.protectedKeywords;

		for (const turn of context) {
			const contentLower = turn.content.toLowerCase();
			let isKey = protectedKeywords.some((kw) => contentLower.includes(kw.toLowerCase()));

			if (turn.metadata?.isKeyTurn || turn.metadata?.phaseTransition) {
				isKey = true;
			}

			if (
				turn.role === "assistant" &&
				["refuse", "cannot", "unable", "sorry", "거부", "죄송"].some((w) => contentLower.includes(w))
			) {
				isKey = true;
			}

			if (isKey) {
				turn.isKeyTurn = true;
				keyTurns.push(turn);
			}
		}

		return keyTurns;
	}

	private applyRecencyWindow(context: TurnEntry[]): TurnEntry[] {
		const windowSize = this.config.recencyWindow;
		if (context.length <= windowSize) return [...context];
		return context.slice(-windowSize);
	}

	private filterByRelevance(context: TurnEntry[], currentTurn?: TurnEntry, keyTurns?: TurnEntry[]): TurnEntry[] {
		if (!currentTurn) return [...context];

		const threshold = this.config.relevanceThreshold;
		const keyIndices = new Set(keyTurns?.map((t) => t.index) ?? []);

		return context.filter((turn) => {
			if (keyIndices.has(turn.index)) return true;
			const score = this.calculateRelevance(turn, currentTurn);
			return score >= threshold;
		});
	}

	private calculateRelevance(turn: TurnEntry, currentTurn: TurnEntry): number {
		const tfidfScore = this.tfidfSimilarity(turn.content, currentTurn.content);
		const recencyScore = Math.exp(-(Date.now() - turn.timestamp) / 3600000);
		return tfidfScore * this.config.tfidfWeight + recencyScore * this.config.recencyWeight;
	}

	private tfidfSimilarity(text1: string, text2: string): number {
		const words1 = text1.toLowerCase().split(/\s+/);
		const words2 = text2.toLowerCase().split(/\s+/);
		const set1 = new Set(words1);
		const set2 = new Set(words2);
		const intersection = new Set([...set1].filter((x) => set2.has(x)));
		return intersection.size / Math.sqrt(set1.size * set2.size);
	}

	private hierarchicalSummarize(
		_context: TurnEntry[],
		recent: TurnEntry[],
		keyTurns: TurnEntry[],
		relevant: TurnEntry[],
	): string {
		const allImportant = [...new Set([...keyTurns, ...relevant, ...recent])].sort((a, b) => a.index - b.index);
		const chunks: string[] = [];

		for (let i = 0; i < allImportant.length; i += this.config.summaryEvery) {
			const chunk = allImportant.slice(i, i + this.config.summaryEvery);
			const summary = chunk.map((t) => `[${t.role}]: ${t.content.substring(0, 100)}`).join(" | ");
			chunks.push(summary);
		}

		return chunks.join("\n");
	}

	private assembleCompressed(
		keyTurns: TurnEntry[],
		relevant: TurnEntry[],
		recent: TurnEntry[],
		_summary: string,
	): TurnEntry[] {
		const important = new Map<number, TurnEntry>();

		for (const turn of keyTurns) important.set(turn.index, turn);
		for (const turn of relevant) important.set(turn.index, turn);
		for (const turn of recent) important.set(turn.index, turn);

		return Array.from(important.values()).sort((a, b) => a.index - b.index);
	}
}

// ── TokenBudgetEnforcer ─────────────────────────────────────────────────

export class TokenBudgetEnforcer extends EventEmitter {
	private config: typeof DEFAULT_CONFIG;

	constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
		super();
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	check(usedTokens: number): BudgetStatus {
		const total = this.config.hardTokenLimit;
		const ratio = usedTokens / total;
		const remaining = total - usedTokens;

		let level: BudgetStatus["level"] = "green";
		if (ratio >= 1.0) level = "exceeded";
		else if (ratio >= this.config.criticalThreshold) level = "red";
		else if (ratio >= this.config.warningThreshold) level = "orange";
		else if (ratio >= 0.6) level = "yellow";

		return {
			usedTokens,
			totalTokens: total,
			ratio,
			level,
			remaining,
			canAddAgents: level === "green" || level === "yellow",
		};
	}

	autoCompressIfNeeded(context: TurnEntry[]): { compressed: TurnEntry[]; status: BudgetStatus } {
		const tokens = context.reduce((sum, t) => sum + Math.ceil(t.content.length / 4), 0);
		const status = this.check(tokens);

		if (status.level === "red" || status.level === "exceeded") {
			const compressor = new ContextCompressor(this.config);
			const result = compressor.compress(context);
			return { compressed: result.turns, status: this.check(result.compressedTokens) };
		}

		return { compressed: context, status };
	}
}

// ── LeanCTXEngine (통합 엔진) ───────────────────────────────────────────

export class LeanCTXEngine extends EventEmitter {
	private compressor: ContextCompressor;
	private budgetEnforcer: TokenBudgetEnforcer;
	private history: TurnEntry[] = [];

	constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
		super();
		this.compressor = new ContextCompressor(config);
		this.budgetEnforcer = new TokenBudgetEnforcer(config);
	}

	processPrompt(prompt: string, role: "user" | "assistant" | "system" = "user"): CompressedContext {
		const currentTurn: TurnEntry = {
			index: this.history.length,
			role,
			content: prompt,
			timestamp: Date.now(),
		};

		const result = this.compressor.compress(this.history, currentTurn);
		this.budgetEnforcer.autoCompressIfNeeded(result.turns);

		this.history.push(currentTurn);
		if (this.history.length > 100) this.history = this.history.slice(-50);

		return result;
	}

	preToolCall(
		_toolName: string,
		_toolArgs: Record<string, any>,
		context: TurnEntry[],
	): { compressed: TurnEntry[]; status: BudgetStatus } {
		return this.budgetEnforcer.autoCompressIfNeeded(context);
	}

	getStats(): { historyLength: number; lastCompression: number } {
		return { historyLength: this.history.length, lastCompression: Date.now() };
	}

	clearHistory(): void {
		this.history = [];
	}
}

export default LeanCTXEngine;
