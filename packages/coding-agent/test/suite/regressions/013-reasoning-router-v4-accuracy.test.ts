import type { ThinkingLevel } from "omk-agent-core";
import { describe, expect, it } from "vitest";

import {
	type ClassifierVerdictV4,
	classifyTaskV4,
	resolveThinkingLevelV4ForAuto,
	resolveThinkingLevelV4WithUncertainty,
	TASK_CLASS_THINKING_LEVELS_V4,
	TASK_CLASSES_V4,
	type TaskClassV4,
} from "../../../src/core/reasoning-router-v4.ts";
import { GOLD_SET, GOLD_SET_VERSION, type GoldEntry } from "../../fixtures/reasoning-router-gold-set.ts";

const FULL_LEVEL_SET: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const levelIndex = (level: ThinkingLevel): number => FULL_LEVEL_SET.indexOf(level);
const SORTED_TASK_CLASSES = [...TASK_CLASSES_V4].sort();

interface GoldVerdict {
	readonly entry: GoldEntry;
	readonly v4: ClassifierVerdictV4;
}

function scoreEntry(entry: GoldEntry): GoldVerdict {
	return { entry, v4: classifyTaskV4({ prompt: entry.prompt }) };
}

const allVerdicts = GOLD_SET.map(scoreEntry);
const holdoutVerdicts = allVerdicts.filter((v) => v.entry.holdout);

const failureSummary = (v: GoldVerdict): string =>
	[
		`id=${v.entry.id}`,
		`expected=${v.entry.expectedClass}`,
		`v4=${v.v4.taskClass}`,
		`fallback=${v.v4.fallbackReason}`,
		`confidence=${v.v4.confidence.toFixed(3)}`,
	].join(" | ");

function correctCount(verdicts: readonly GoldVerdict[]): number {
	return verdicts.filter((v) => v.v4.taskClass === v.entry.expectedClass).length;
}

describe("reasoning-router v4 accuracy + confidence-metadata suite", () => {
	describe("gold-set classification", () => {
		it("HARD gate: v4 classifies every full gold-set row correctly", () => {
			const failures = allVerdicts.filter((v) => v.v4.taskClass !== v.entry.expectedClass).map((v) => v.entry.id);
			expect(failures, `misclassified ids: ${failures.join(",") || "none"}`).toEqual([]);
		});

		it("HARD gate: v4 classifies every holdout row correctly", () => {
			const failures = holdoutVerdicts
				.filter((v) => v.v4.taskClass !== v.entry.expectedClass)
				.map((v) => v.entry.id);
			expect(failures, `holdout misclassified ids: ${failures.join(",") || "none"}`).toEqual([]);
		});

		for (const v of allVerdicts) {
			it(`${v.entry.id}: v4 taskClass matches expectedClass`, () => {
				expect(v.v4.taskClass, failureSummary(v)).toBe(v.entry.expectedClass);
			});
		}

		it("prints REASONING-ROUTER-V4-BENCHMARK summary", () => {
			const fullAccuracy = correctCount(allVerdicts) / allVerdicts.length;
			const holdoutAccuracy = correctCount(holdoutVerdicts) / holdoutVerdicts.length;
			const summary = {
				version: "v4-accuracy",
				goldSetVersion: GOLD_SET_VERSION,
				fullN: allVerdicts.length,
				holdoutN: holdoutVerdicts.length,
				fullAccuracy: Number(fullAccuracy.toFixed(4)),
				holdoutAccuracy: Number(holdoutAccuracy.toFixed(4)),
			};
			console.log(`REASONING-ROUTER-V4-BENCHMARK ${JSON.stringify(summary)}`);
			expect(summary.fullAccuracy).toBe(1);
			expect(summary.holdoutAccuracy).toBe(1);
		});
	});

	describe("confidence metadata is well-formed on every gold row", () => {
		it("exposes the v4 plan thinking-level mapping", () => {
			expect(TASK_CLASS_THINKING_LEVELS_V4.plan).toBe("xhigh");
			expect(TASK_CLASS_THINKING_LEVELS_V4.trivial).toBe("minimal");
		});

		for (const v of allVerdicts) {
			it(`${v.entry.id}: verdict has a well-formed score map, margin, confidence band, and audit flags`, () => {
				expect(Object.keys(v.v4.scores).sort(), failureSummary(v)).toEqual(SORTED_TASK_CLASSES);
				for (const c of TASK_CLASSES_V4) {
					expect(v.v4.scores[c], `${failureSummary(v)} class=${c}`).toBeGreaterThanOrEqual(0);
				}
				expect(v.v4.margin, failureSummary(v)).toBeGreaterThanOrEqual(0);
				expect(v.v4.confidence, failureSummary(v)).toBeGreaterThanOrEqual(0);
				expect(v.v4.confidence, failureSummary(v)).toBeLessThanOrEqual(1);
				expect(["low", "medium", "high"], failureSummary(v)).toContain(v.v4.confidenceBand);
				expect(typeof v.v4.tieBreak, failureSummary(v)).toBe("boolean");
				expect(typeof v.v4.compoundIntent, failureSummary(v)).toBe("boolean");
				expect(Array.isArray(v.v4.suppressedFeatureIds), failureSummary(v)).toBe(true);
				for (const id of v.v4.suppressedFeatureIds) {
					expect(id, failureSummary(v)).toMatch(/^negation:/);
				}
			});
		}

		it("HARD gate: uncertainty resolution never resolves below the confident path", () => {
			for (const v of allVerdicts) {
				const confidentLevel = resolveThinkingLevelV4ForAuto(v.v4.taskClass, FULL_LEVEL_SET, undefined);
				const uncertainLevel = resolveThinkingLevelV4WithUncertainty(v.v4, FULL_LEVEL_SET, undefined);
				expect(levelIndex(uncertainLevel), failureSummary(v)).toBeGreaterThanOrEqual(levelIndex(confidentLevel));
			}
		});
	});

	describe("bounded negation", () => {
		it("negated refactor cue does not steal a debug-evidenced prompt", () => {
			const verdict = classifyTaskV4({ prompt: "don't refactor this, just fix the crash" });
			expect(verdict.taskClass).toBe("debug");
			expect(verdict.suppressedFeatureIds).toContain("negation:refactor-cue");
			expect(verdict.scores.refactor).toBe(0);
		});

		it("negated review keyword lets an unnegated code-gen verb win", () => {
			const verdict = classifyTaskV4({ prompt: "skip the review, just build the feature" });
			expect(verdict.taskClass).toBe("code-gen");
			expect(verdict.suppressedFeatureIds).toContain("negation:keyword-review");
			expect(verdict.scores.review).toBe(0);
		});

		it("does not suppress a keyword that appears before the negation cue", () => {
			const verdict = classifyTaskV4({ prompt: "refactor for readability without changing behavior" });
			expect(verdict.taskClass).toBe("refactor");
			expect(verdict.suppressedFeatureIds).toEqual([]);
		});

		it("does not let a negation cue cross a sentence boundary into a later clause", () => {
			const verdict = classifyTaskV4({ prompt: "this isn't a bug. refactor the parser." });
			expect(verdict.suppressedFeatureIds).toContain("negation:bug-object");
			expect(verdict.scores.debug).toBe(0);
			expect(verdict.taskClass).toBe("refactor");
			expect(verdict.scores.refactor).toBeGreaterThan(0);
		});
	});

	describe("bounded compound intent", () => {
		it("detects a genuine second, distinct leading intent", () => {
			const verdict = classifyTaskV4({ prompt: "review the diff and then implement the fix" });
			expect(verdict.taskClass).toBe("review");
			expect(verdict.compoundIntent).toBe(true);
			expect(verdict.secondClauseIntent).toBe("code-gen");
			expect(verdict.confidenceBand).toBe("medium");
			expect(verdict.margin).toBeLessThan(verdict.scores.review);
		});

		it("does not fire inside a long prose brief", () => {
			const longPlanEntry = GOLD_SET.find((entry) => entry.id === "gold-0208");
			expect(longPlanEntry).toBeDefined();
			const verdict = classifyTaskV4({ prompt: longPlanEntry?.prompt ?? "" });
			expect(verdict.compoundIntent).toBe(false);
			expect(verdict.taskClass).toBe("plan");
		});

		it("does not fire on a bare 'and'", () => {
			const verdict = classifyTaskV4({ prompt: "audit the api and generate the docs" });
			expect(verdict.compoundIntent).toBe(false);
		});
	});

	describe("multilingual routing", () => {
		const cases: readonly { prompt: string; expectedClass: TaskClassV4 }[] = [
			{ prompt: "오타 'recieve'를 'receive'로 고쳐줘", expectedClass: "simple-edit" },
			{ prompt: "fetch 호출에 에러 처리를 추가해줘", expectedClass: "code-gen" },
			{ prompt: "diff를 리뷰해서 회귀가 있는지 확인해줘", expectedClass: "review" },
			{ prompt: "감사 로그 아키텍처를 설계해줘", expectedClass: "plan" },
			{ prompt: "크래시를 재현하고 원인을 디버깅해줘", expectedClass: "debug" },
		];

		it.each(cases)("routes $prompt to $expectedClass", ({ prompt, expectedClass }) => {
			expect(classifyTaskV4({ prompt }).taskClass).toBe(expectedClass);
		});

		it.each([
			{ prompt: "오류 고쳐줘", expectedClass: "debug" as const },
			{ prompt: "테스트 실패 원인 분석해줘", expectedClass: "debug" as const },
			{ prompt: "디버깅해줘", expectedClass: "debug" as const },
			// 016: modification verbs (삭제/바꿔/수정/고쳐) are simple-edit, not code-gen —
			// creation-vs-modification split matches the English verb semantics.
			{ prompt: "안 쓰는 코드 삭제해줘", expectedClass: "simple-edit" as const },
			{ prompt: "버튼 색 바꿔줘", expectedClass: "simple-edit" as const },
		])("routes short zero-score Korean task signal $prompt via bounded fallback", ({ prompt, expectedClass }) => {
			const verdict = classifyTaskV4({ prompt });
			expect(verdict.taskClass).toBe(expectedClass);
			expect(verdict.fallbackReason).toBe("ko-short-task-signal");
			expect(verdict.scores[expectedClass]).toBe(0);
		});

		it("keeps short Korean greeting without task signal trivial", () => {
			const verdict = classifyTaskV4({ prompt: "안녕하세요" });
			expect(verdict.taskClass).toBe("trivial");
			expect(verdict.fallbackReason).toBe("trivial-length");
		});

		it("handles Korean post-positioned refactor negation without stealing a crash fix", () => {
			const verdict = classifyTaskV4({ prompt: "리팩토링하지 말고 크래시만 고쳐줘" });
			expect(verdict.taskClass).toBe("debug");
			expect(verdict.scores.refactor).toBe(0);
			expect(verdict.scores.debug).toBeGreaterThan(0);
		});
	});

	describe("operational runbook intent", () => {
		it("promotes release-bound commit/push/publish bundles to plan", () => {
			const prompt =
				"이제 깃헙 커밋, 푸쉬, 릴리즈 업데이트, omk tui 0.90.4, 채널로그, README.md, CI/CD, npm publish까지 완벽하게 가자";
			const verdict = classifyTaskV4({ prompt });
			expect(verdict.taskClass).toBe("plan");
			expect(verdict.fallbackReason).toBeNull();
			expect(verdict.scores.plan).toBeGreaterThan(verdict.scores["code-gen"]);
			expect(verdict.confidenceBand).toBe("high");
		});

		it("does not over-promote plain README and changelog copy edits", () => {
			const verdict = classifyTaskV4({ prompt: "update the README title and reword the changelog entry" });
			expect(verdict.taskClass).toBe("simple-edit");
			expect(verdict.scores.plan).toBe(0);
		});
	});

	describe("tie-break metadata", () => {
		it("surfaces a genuine precedence tie between two equally-weighted keyword families", () => {
			const verdict = classifyTaskV4({ prompt: "please help with an audit and generate a report" });
			expect(verdict.taskClass).toBe("review");
			expect(verdict.runnerUp).toBe("code-gen");
			expect(verdict.margin).toBe(0);
			expect(verdict.tieBreak).toBe(true);
			expect(verdict.confidence).toBe(0);
			expect(verdict.confidenceBand).toBe("low");
		});
	});

	describe("deterministic behavior", () => {
		it("classifyTaskV4 is deterministic across repeated calls on every gold prompt", () => {
			for (const v of allVerdicts) {
				const first = classifyTaskV4({ prompt: v.entry.prompt });
				for (let i = 0; i < 5; i++) {
					expect(classifyTaskV4({ prompt: v.entry.prompt }), v.entry.id).toEqual(first);
				}
			}
		});
	});
});
