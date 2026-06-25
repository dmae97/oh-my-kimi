// packages/coding-agent/src/core/token-optimizer.ts
// ===========================================
//
// @deprecated 이 모듈은 현재 코드베이스 어디에서도 import되지 않는 dead code입니다.
// 어떤 파일도 이 모듈의 클래스를 직접 사용하지 않습니다.
// 향후 토큰 최적화가 필요하면 headroom/global-context-compressor를 사용하세요.
//
// LosslessCompressor 계약:
//   compress() 출력은 의미적으로 원본과 동일해야 합니다.
//   - 문장 내 단어를 제거/대체/재배치하지 않습니다 (중복 단어 포함).
//   - 연속 공백/탭/줄바꿈 정규화만 수행합니다 (의미 불변).
//   - tokensSaved는 실제 토큰 수 차이를 보고합니다 (과대 계산 금지).
//
// v2.0 변경사항:
//   - [fix] Result deduplication 로직 제거 (중복 단어 제거 → 의미 파괴 버그)
//   - [fix] abbreviationMap 제거 (문맥 의존적 축약은 손실/lossy)
//   - [fix] templateCache 제거 (32비트 해시 충돌 시 잘못된 압축 반환)
//   - [fix] tokensSaved를 estimateTokens() 기반으로 정확화
//   - [fix] tokensSaved가 음수가 될 수 없음 보장
//   - compress()는 whitespace 정규화만 수행 (진정한 lossless)

import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// 토큰 추정 — BPE 토크나이저 근사
// ---------------------------------------------------------------------------
// OpenAI BPE 토크나이저의 동작을 근사:
//   - 일반 영어 단어(빈도 높음)는 대개 1 토큰
//   - 긴/드문 단어는 1 + ceil((len - 1) / 4) 토큰으로 분할
//   - 구두점/특수문자는 보통 각각 1 토큰
//   - 공백 문자는 단어 접두사로 병합되므로 별도 토큰이 아님
//   - CJK 문자는 보통 1자 = 1~2 토큰

function estimateTokens(text: string): number {
	if (text.length === 0) return 0;

	let tokens = 0;
	// 공백으로 분할 — 각 청크를 개별적으로 추정
	const chunks = text.split(/(\s+)/);

	for (const chunk of chunks) {
		if (chunk.length === 0) continue;
		if (/^\s+$/.test(chunk)) {
			// 공백 문자열 — BPE에서 단어 접두사로 병합됨, 토큰 0
			continue;
		}

		// CJK 문자 분리 (유니코드 범위: 한글, 한자, 가타나)
		const cjkChars = chunk.match(/[\u3000-\u9fff\uf900-\ufaff]/g);
		if (cjkChars) {
			// CJK: 1자 ≈ 1.5 토큰 (평균)
			tokens += Math.ceil(cjkChars.length * 1.5);
			continue;
		}

		// 영어 단어/숫자/구두점 청크
		if (chunk.length <= 6) {
			// 짧은 단어(빈도 높음): 대개 단일 토큰
			tokens += 1;
		} else {
			// 긴 단어: BPE가 subword로 분할 → 1 + 분할 조각 수
			tokens += 1 + Math.ceil((chunk.length - 1) / 4);
		}
	}

	return tokens;
}

// ---------------------------------------------------------------------------
// 인터페이스 (역호환)
// ---------------------------------------------------------------------------

export interface TokenOptimizationResult {
	originalQuery: string;
	optimizedQuery: string;
	tokensSaved: number;
	technique: string;
	cacheHit: boolean;
}

// ---------------------------------------------------------------------------
// LosslessCompressor — 진정한 무손실 압축
// ---------------------------------------------------------------------------
// 압축 후 역압축 시 원본 복원 가능(의미 100% 보존).
// 수행하는 변환:
//   1. 연속 공백/탭 → 단일 공백
//   2. 앞뒤 공백 제거(trim)
//
// 이 두 변환만 수행합니다. 어떤 단어도 제거/대체하지 않습니다.

export class LosslessCompressor extends EventEmitter {
	compress(query: string): { compressed: string; tokensSaved: number } {
		const originalTokens = estimateTokens(query);

		// 1. 연속 공백/탭 → 단일 공백
		// 2. trim
		const compressed = query.replace(/[ \t]+/g, " ").trim();

		const compressedTokens = estimateTokens(compressed);
		// tokensSaved는 0 이상 — 정규화가 토큰을 줄이지 않으면 0
		const tokensSaved = Math.max(0, originalTokens - compressedTokens);

		return { compressed, tokensSaved };
	}
}

// ---------------------------------------------------------------------------
// LazyExecutor — 메모이제이션 실행기 (역호환)
// ---------------------------------------------------------------------------

export class LazyExecutor extends EventEmitter {
	private memoCache: Map<string, unknown> = new Map();

	execute<T>(taskId: string, fn: () => T, force = false): T {
		if (!force && this.memoCache.has(taskId)) {
			return this.memoCache.get(taskId) as T;
		}
		const result = fn();
		this.memoCache.set(taskId, result);
		return result;
	}

	clear(): void {
		this.memoCache.clear();
	}
}

// ---------------------------------------------------------------------------
// AdaptiveBudget — 토큰 예산 관리 (역호환)
// ---------------------------------------------------------------------------

export class AdaptiveBudget extends EventEmitter {
	private budget: number;
	private used: number = 0;
	private history: { used: number; timestamp: number }[] = [];

	constructor(initialBudget = 10000) {
		super();
		this.budget = initialBudget;
	}

	allocate(tokens: number): boolean {
		if (this.used + tokens > this.budget) {
			this.emit("budgetExceeded", { used: this.used, requested: tokens, budget: this.budget });
			return false;
		}
		this.used += tokens;
		this.history.push({ used: this.used, timestamp: Date.now() });
		return true;
	}

	getStats(): { budget: number; used: number; remaining: number; utilization: number } {
		return {
			budget: this.budget,
			used: this.used,
			remaining: this.budget - this.used,
			utilization: this.used / this.budget,
		};
	}

	adjustBudget(newBudget: number): void {
		this.budget = newBudget;
		this.emit("budgetAdjusted", { newBudget });
	}
}

// ---------------------------------------------------------------------------
// TokenOptimizer — 통합 인터페이스 (역호환)
// ---------------------------------------------------------------------------

export class TokenOptimizer extends EventEmitter {
	private compressor: LosslessCompressor;
	private executor: LazyExecutor;
	private budget: AdaptiveBudget;

	constructor(budget = 10000) {
		super();
		this.compressor = new LosslessCompressor();
		this.executor = new LazyExecutor();
		this.budget = new AdaptiveBudget(budget);
	}

	optimize(query: string): TokenOptimizationResult {
		const originalTokens = estimateTokens(query);

		const { compressed } = this.compressor.compress(query);
		const optimizedTokens = estimateTokens(compressed);

		const cacheHit = false; // templateCache 제거됨 — 항상 false

		this.budget.allocate(optimizedTokens);

		return {
			originalQuery: query,
			optimizedQuery: compressed,
			tokensSaved: Math.max(0, originalTokens - optimizedTokens),
			technique: "whitespace_normalization",
			cacheHit,
		};
	}

	lazyExecute<T>(taskId: string, fn: () => T): T {
		return this.executor.execute(taskId, fn);
	}

	getBudgetStats(): { budget: number; used: number; remaining: number; utilization: number } {
		return this.budget.getStats();
	}
}

export default TokenOptimizer;
