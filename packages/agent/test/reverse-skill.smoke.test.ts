import { describe, expect, it } from "vitest";
import { normalizeReverseSkillName, REVERSE_SKILL_ROUTES, routeReverseSkill } from "../src/index.ts";

// Smoke test for the deduplicated canonical reverse-skill module. The
// coding-agent copy is now a thin re-export of this implementation through the
// omk-agent-core public entry, so this asserts the canonical module is reachable
// through the public specifier and that deterministic behavior is stable.
// Assertions mirror packages/coding-agent/test/reverse-skill.test.ts.
describe("reverse-skill canonical module (omk-agent-core public surface)", () => {
	it("normalizes skill names and routes frontend signature work deterministically", () => {
		expect(normalizeReverseSkillName("APK Reverse!! Workflow__2026")).toBe("apk-reverse-workflow-2026");

		const decision = routeReverseSkill({
			query: "Find the frontend signature and encrypted params in a webpack app using CDP breakpoints",
		});
		expect(decision.unmatched).toBe(false);
		expect(decision.primary?.route.id).toBe("js-reverse");
	});

	it("routes repository-to-prompt reconstruction to gitreverse through the public entry", () => {
		const decision = routeReverseSkill({
			query: "Turn https://github.com/vercel/next.js into one prompt I can paste into Cursor to vibe code it from scratch",
		});

		expect(decision.unmatched).toBe(false);
		expect(decision.primary?.route.id).toBe("gitreverse");
		expect(REVERSE_SKILL_ROUTES.some((route) => route.id === "gitreverse")).toBe(true);
	});
});
