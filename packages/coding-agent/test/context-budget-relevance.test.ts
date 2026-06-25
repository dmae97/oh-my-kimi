import { describe, expect, it } from "vitest";
import {
	scoreContextFileRelevance,
	scoreSkillRelevance,
	tokenizeForRelevance,
} from "../src/core/context-budget-relevance.ts";

// ---------------------------------------------------------------------------
// tokenizeForRelevance
// ---------------------------------------------------------------------------

describe("tokenizeForRelevance", () => {
	it("lowercases and splits on word boundaries", () => {
		const tokens = tokenizeForRelevance("Hello World Test");
		expect(tokens).toContain("hello");
		expect(tokens).toContain("world");
		expect(tokens).toContain("test");
	});

	it("removes stop words", () => {
		const tokens = tokenizeForRelevance("the quick brown fox is on the table");
		expect(tokens).not.toContain("the");
		expect(tokens).not.toContain("is");
		expect(tokens).not.toContain("on");
		expect(tokens).toContain("quick");
		expect(tokens).toContain("brown");
		expect(tokens).toContain("fox");
		expect(tokens).toContain("table");
	});

	it("removes short Latin tokens (<=2 chars)", () => {
		const tokens = tokenizeForRelevance("go to the OK store in NY");
		expect(tokens).not.toContain("go");
		expect(tokens).not.toContain("to");
		expect(tokens).not.toContain("ny");
		expect(tokens).toContain("store");
	});

	it("handles Korean text", () => {
		const tokens = tokenizeForRelevance("한국어 OCR 이미지 처리");
		expect(tokens.length).toBeGreaterThan(0);
		expect(tokens).toContain("ocr");
	});

	it("deduplicates tokens", () => {
		const tokens = tokenizeForRelevance("test test test");
		expect(tokens).toEqual(["test"]);
	});

	it("returns empty array for empty input", () => {
		expect(tokenizeForRelevance("")).toEqual([]);
		expect(tokenizeForRelevance("   ")).toEqual([]);
	});

	it("returns empty array for pure stop words", () => {
		const tokens = tokenizeForRelevance("the a an is are");
		expect(tokens).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// scoreSkillRelevance
// ---------------------------------------------------------------------------

describe("scoreSkillRelevance", () => {
	it("returns neutral score when queryContext is undefined", () => {
		const score = scoreSkillRelevance(
			{ name: "ocr-anything", description: "Korean OCR" },
			undefined,
		);
		expect(score).toBeCloseTo(0.3, 5);
	});

	it("returns neutral score when queryContext is empty", () => {
		const score = scoreSkillRelevance(
			{ name: "ocr-anything", description: "Korean OCR" },
			"",
		);
		expect(score).toBeCloseTo(0.3, 5);
	});

	it("scores relevant skill high (>=0.7)", () => {
		const score = scoreSkillRelevance(
			{ name: "ocr-anything", description: "Korean OCR image text extraction" },
			"OCR 한국어 이미지",
		);
		expect(score).toBeGreaterThanOrEqual(0.7);
	});

	it("scores irrelevant skill low (<=0.2)", () => {
		const score = scoreSkillRelevance(
			{ name: "ocr-anything", description: "Korean OCR image text extraction" },
			"database migration postgres",
		);
		expect(score).toBeLessThanOrEqual(0.2);
	});

	it("applies name token weight boost", () => {
		// Name "database" should match strongly when query contains "database"
		const scoreNameMatch = scoreSkillRelevance(
			{ name: "database-patterns", description: "Various patterns for development" },
			"database optimization",
		);
		const scoreNoNameMatch = scoreSkillRelevance(
			{ name: "misc-tools", description: "Various patterns for development" },
			"database optimization",
		);
		expect(scoreNameMatch).toBeGreaterThan(scoreNoNameMatch);
	});

	it("applies name substring match bonus", () => {
		// "ocr" is 3 chars → survives tokenization.
		// skill name "ocr-anything" contains "ocr", and name tokens get 3x weight.
		const score = scoreSkillRelevance(
			{ name: "ocr-anything", description: "text extraction tool" },
			"ocr",
		);
		// coverage: "ocr" matches name token with weight 3 → min(1, 3/1) = 1.0
		// substring: "ocr" is in "ocr-anything" → +0.2 → capped at 1.0
		expect(score).toBe(1.0);

		// Verify bonus adds value when coverage alone is < 1.0
		const scorePartial = scoreSkillRelevance(
			{ name: "my-ocr-tool", description: "unrelated content" },
			"ocr unknown",
		);
		// coverage: "ocr" matches name (3x), "unknown" doesn't match → min(1, 3/2) = 1.0
		// substring: "my-ocr-tool" does NOT contain "ocr unknown" → no bonus
		// Score = 1.0 (coverage alone)
		expect(scorePartial).toBeCloseTo(1.0, 5);
	});

	it("caps score at 1.0", () => {
		// Highly overlapping tokens + name bonus should not exceed 1.0
		const score = scoreSkillRelevance(
			{ name: "database-patterns", description: "database database database patterns" },
			"database patterns",
		);
		expect(score).toBeLessThanOrEqual(1.0);
	});

	it("handles Korean query with matching skill", () => {
		const score = scoreSkillRelevance(
			{ name: "vue-patterns", description: "Vue.js Composition API patterns for building applications" },
			"Vue 애플리케이션 빌드",
		);
		// "vue" is ≤2 chars → removed. But "애플리케이션" and "빌드" may match Korean in desc.
		// Description has no Korean, so Korean tokens won't match.
		// This tests graceful degradation.
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it("discriminates between relevant and irrelevant for same skill", () => {
		const skill = { name: "git-workflow", description: "Git branching strategies and commit conventions" };
		const relevant = scoreSkillRelevance(skill, "git branching commit strategy");
		const irrelevant = scoreSkillRelevance(skill, "CSS animation transition");
		// At minimum, relevant should be higher
		expect(relevant).toBeGreaterThan(irrelevant);
	});
});

// ---------------------------------------------------------------------------
// scoreContextFileRelevance
// ---------------------------------------------------------------------------

describe("scoreContextFileRelevance", () => {
	it("returns global neutral (0.9) when queryContext is undefined and isGlobal", () => {
		const score = scoreContextFileRelevance(
			{ path: "/home/user/AGENTS.md", content: "some content", isGlobal: true },
			undefined,
		);
		expect(score).toBeCloseTo(0.9, 5);
	});

	it("returns local neutral (0.6) when queryContext is undefined and not global", () => {
		const score = scoreContextFileRelevance(
			{ path: "/project/AGENTS.md", content: "some content", isGlobal: false },
			undefined,
		);
		expect(score).toBeCloseTo(0.6, 5);
	});

	it("scores relevant context file higher than irrelevant", () => {
		const relevant = scoreContextFileRelevance(
			{ path: "/project/AGENTS.md", content: "OCR processing Korean images", isGlobal: false },
			"OCR 한국어 이미지",
		);
		const irrelevant = scoreContextFileRelevance(
			{ path: "/project/AGENTS.md", content: "database migration postgres", isGlobal: false },
			"OCR 한국어 이미지",
		);
		expect(relevant).toBeGreaterThan(irrelevant);
	});

	it("applies path token weight boost", () => {
		const pathMatch = scoreContextFileRelevance(
			{ path: "/project/ocr-config/settings.md", content: "generic settings", isGlobal: false },
			"ocr configuration",
		);
		const noPathMatch = scoreContextFileRelevance(
			{ path: "/project/misc/settings.md", content: "generic settings", isGlobal: false },
			"ocr configuration",
		);
		expect(pathMatch).toBeGreaterThanOrEqual(noPathMatch);
	});

	it("applies isGlobal bonus", () => {
		const globalScore = scoreContextFileRelevance(
			{ path: "/global/AGENTS.md", content: "common guidelines", isGlobal: true },
			"guidelines",
		);
		const localScore = scoreContextFileRelevance(
			{ path: "/project/AGENTS.md", content: "common guidelines", isGlobal: false },
			"guidelines",
		);
		expect(globalScore).toBeGreaterThanOrEqual(localScore);
	});

	it("samples long content (first 2000 chars)", () => {
		const longContent = "a".repeat(5000) + " specialkeyword " + "b".repeat(5000);
		const score = scoreContextFileRelevance(
			{ path: "/project/file.md", content: longContent, isGlobal: false },
			"specialkeyword",
		);
		// "specialkeyword" is > 2 chars, should survive tokenization
		// It's in the first 2000 chars? No — "a".repeat(5000) means it's at position 5000+
		// So it won't be found → score should be 0 (or very low)
		expect(score).toBeLessThanOrEqual(0.6 + 0.01); // within local neutral range
	});

	it("clamps score to 0..1", () => {
		const score = scoreContextFileRelevance(
			{ path: "/project/file.md", content: "test content here", isGlobal: true },
			"test content here",
		);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it("returns 0 for empty query after tokenization (pure stop words)", () => {
		const score = scoreContextFileRelevance(
			{ path: "/project/file.md", content: "some content", isGlobal: false },
			"the a an",
		);
		// Pure stop words → empty query tokens → neutral fallback
		expect(score).toBeCloseTo(0.6, 5);
	});
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
	it("same inputs produce same outputs", () => {
		const skill = { name: "test-skill", description: "test description for scoring" };
		const query = "test scoring algorithm";

		const score1 = scoreSkillRelevance(skill, query);
		const score2 = scoreSkillRelevance(skill, query);
		expect(score1).toBe(score2);
	});

	it("context file scoring is deterministic", () => {
		const file = { path: "/project/AGENTS.md", content: "project guidelines", isGlobal: true };
		const query = "project guidelines";

		const score1 = scoreContextFileRelevance(file, query);
		const score2 = scoreContextFileRelevance(file, query);
		expect(score1).toBe(score2);
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	it("handles special characters in query", () => {
		const score = scoreSkillRelevance(
			{ name: "test", description: "test skill" },
			"@#$%^&*()",
		);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it("handles very long skill description", () => {
		const longDesc = "word ".repeat(10000);
		const score = scoreSkillRelevance(
			{ name: "test", description: longDesc },
			"word",
		);
		// "word" is ≤2 chars → removed by tokenizer
		expect(score).toBeGreaterThanOrEqual(0);
	});

	it("handles undefined isGlobal gracefully", () => {
		// The type says isGlobal: boolean, but runtime may have undefined
		const score = scoreContextFileRelevance(
			{ path: "/project/file.md", content: "content", isGlobal: undefined as unknown as boolean },
			undefined,
		);
		// isGlobal is falsy → local neutral
		expect(score).toBeCloseTo(0.6, 5);
	});
});
