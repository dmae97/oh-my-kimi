import { describe, expect, it } from "vitest";
import { getDomainProfile } from "../src/core/domain-loadouts.ts";
import { composeLoadout } from "../src/core/loadout-compose.ts";
import { SECURITY_HOOK_NAMES } from "../src/core/loadout-safety.ts";
import {
	BUILTIN_LOADOUTS,
	inferLoadoutForRole,
	type LoadoutRole,
	validateLoadoutProfile,
} from "../src/core/loadouts.ts";

const expectValidProfile = (role: LoadoutRole, domainId: string): void => {
	const composed = composeLoadout(role, domainId);
	expect(validateLoadoutProfile(composed)).toEqual({ valid: true, errors: [] });

	const roleTools = new Set(BUILTIN_LOADOUTS[inferLoadoutForRole(role)].tools.allow ?? []);
	for (const toolName of composed.tools.allow ?? []) {
		expect(roleTools.has(toolName)).toBe(true);
	}
};

describe("composeLoadout", () => {
	it("validates representative role/domain combinations", () => {
		expectValidProfile("coder", "frontend-ui");
		expectValidProfile("tester", "data-science");
		expectValidProfile("security", "backend-api");
	});

	it("keeps write tools and full filesystem MCP for a write-scoped reviewer in a frontend domain", () => {
		const composed = composeLoadout("reviewer", getDomainProfile("frontend-ui"));

		expect(composed.authority).toBe("write-scoped");
		expect(composed.tools.allow).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		expect(composed.tools.allow).toContain("edit");
		expect(composed.tools.allow).toContain("write");
		expect(composed.tools.allow).toContain("bash");
		expect(composed.commands).toEqual({ mode: "scoped-shell" });
		expect(composed.mcp?.allow?.[0]?.names).toContain("filesystem");
		expect(composed.mcp?.allow?.[0]?.names).not.toContain("filesystem-readonly");
		expect(composed.skills?.allow?.[0]?.names).toContain("frontend-ui-engineering");
		expect(composed.composition.downgraded).toEqual([]);
		expect(composed.composition.stripped).toEqual([]);
		expect(validateLoadoutProfile(composed)).toEqual({ valid: true, errors: [] });
	});

	it("forces security hooks for every composed loadout", () => {
		const composed = composeLoadout("planner", "research");
		const hookNames = composed.hooks?.allow?.[0]?.names ?? [];

		for (const hookName of SECURITY_HOOK_NAMES) {
			expect(hookNames).toContain(hookName);
		}
	});

	it("caps authority with the optional grant authority", () => {
		const composed = composeLoadout("coder", "frontend-ui", { grantAuthority: "execute-tests" });

		expect(composed.authority).toBe("execute-tests");
		expect(composed.commands).toEqual({ mode: "tests-only" });
		expect(validateLoadoutProfile(composed)).toEqual({ valid: true, errors: [] });
	});
});
