/**
 * Goal 016 regression: Korean morphology routing after hard-negative mining.
 *
 * Evidence: scripts/reasoning-router/mine-hard-negatives.ts found 12/180 M4
 * failures — modification verbs (바꿔/바꾸/수정/변경/고쳐/고치/삭제/제거/옮겨) were
 * assigned to the code-gen morphology cluster, and the zero-score Korean
 * fallback only applied to <40-char prompts. The fix:
 *   1. Modification verbs moved to korean-simple-edit-morphology;
 *      korean-code-gen-morphology keeps creation verbs only.
 *   2. The zero-score Korean morphology check now runs at any prompt length.
 *
 * Invariants guarded here: modification verbs route to simple-edit, creation
 * verbs stay code-gen, and the English router behavior is untouched.
 */
import { describe, expect, it } from "vitest";
import { classifyTaskV4 } from "../../../src/core/reasoning-router-v4.ts";

describe("reasoning-router v4 goal-016 Korean morphology", () => {
	it.each([
		"바꿔줘: bump the version to 1.2.3",
		"수정해줘: bump dependencies",
		"고쳐줘: reword the warning message",
		"바꿔줘: tweak the button label copy",
		"버튼 색 바꿔줘",
		"안 쓰는 코드 삭제해줘",
	])("routes Korean modification verb to simple-edit: %s", (prompt) => {
		const verdict = classifyTaskV4({ prompt });
		expect(verdict.taskClass).toBe("simple-edit");
	});

	it("routes >40-char zero-score Korean edit prompts by morphology (was code-gen default)", () => {
		// >40 chars with no English signal: previously fell through to the code-gen
		// default because the Korean morphology check only ran in the <40-char branch.
		const verdict = classifyTaskV4({
			prompt: "바꿔줘: 회원가입 버튼의 색상과 모서리 반경을 조금 더 부드럽게 조정해 주세요",
		});
		expect(verdict.taskClass).toBe("simple-edit");
		expect(verdict.fallbackReason).toBe("ko-short-task-signal");
	});

	it.each(["구현해줘: 새 캐시 레이어", "만들어줘: 로그인 폼", "추가해줘: 새 엔드포인트", "생성해줘: 리포트 템플릿"])(
		"keeps Korean creation verbs on code-gen: %s",
		(prompt) => {
			expect(classifyTaskV4({ prompt }).taskClass).toBe("code-gen");
		},
	);

	it.each([
		["fix the typo in the README title", "simple-edit"],
		["implement a rate limiter", "code-gen"],
		["review this diff", "review"],
		["bump the version to 1.2.3", "simple-edit"],
	] as const)("does not change English routing: %s", (prompt, expected) => {
		expect(classifyTaskV4({ prompt }).taskClass).toBe(expected);
	});

	it("is deterministic across repeated calls on Korean prompts", () => {
		const prompt = "바꿔줘: bump the version to 1.2.3";
		const first = classifyTaskV4({ prompt });
		const second = classifyTaskV4({ prompt });
		expect(second).toEqual(first);
	});
});
