import { describe, expect, it } from "vitest";
import {
	DOMAIN_IDS,
	DOMAIN_PROFILES,
	domainLoadoutProfiles,
	FALLBACK_DOMAIN_ID,
	getDomainProfile,
} from "../src/core/domain-loadouts.ts";
import { BUILTIN_HOOKS } from "../src/core/hook-inventory.ts";
import { validateLoadoutProfile } from "../src/core/loadouts.ts";

// Mirrors the private AUTHORITY_RANK keys in loadouts.ts.
const VALID_AUTHORITIES = new Set([
	"advisory",
	"read-only",
	"review-only",
	"security-review",
	"execute-tests",
	"write-scoped",
]);
// Mirrors the private KNOWN_COMMAND_MODES set in loadouts.ts.
const VALID_COMMAND_MODES = new Set(["none", "read-only-shell", "tests-only", "scoped-shell"]);

describe("domain-loadouts registry", () => {
	it("exposes a non-empty set of curated domains plus a general fallback", () => {
		expect(DOMAIN_IDS.length).toBeGreaterThanOrEqual(10);
		expect(DOMAIN_PROFILES[FALLBACK_DOMAIN_ID]).toBeDefined();
		expect(DOMAIN_IDS).not.toContain(FALLBACK_DOMAIN_ID);
	});

	it("has unique ids that match the profile.id field", () => {
		const seen = new Set<string>();
		for (const [key, profile] of Object.entries(DOMAIN_PROFILES)) {
			expect(key, "registry key must equal profile.id").toBe(profile.id);
			expect(seen.has(profile.id), `duplicate id: ${profile.id}`).toBe(false);
			seen.add(profile.id);
		}
	});

	it("every profile is a valid LoadoutProfile (schema, authority, command mode)", () => {
		for (const profile of Object.values(DOMAIN_PROFILES)) {
			const validation = validateLoadoutProfile(profile);
			expect(validation.valid, `${profile.id}: ${validation.errors.join("; ")}`).toBe(true);
			expect(VALID_AUTHORITIES.has(profile.authority)).toBe(true);
			if (profile.commands) expect(VALID_COMMAND_MODES.has(profile.commands.mode)).toBe(true);
		}
	});

	it("every profile curates non-empty skills, mcp, and hooks bundles", () => {
		for (const profile of Object.values(DOMAIN_PROFILES)) {
			const skills = profile.skills?.allow?.[0]?.names ?? [];
			const mcp = profile.mcp?.allow?.[0]?.names ?? [];
			const hooks = profile.hooks?.allow?.[0]?.names ?? [];
			expect(skills.length, `${profile.id} must curate skills`).toBeGreaterThan(0);
			expect(mcp.length, `${profile.id} must curate mcp`).toBeGreaterThan(0);
			expect(hooks.length, `${profile.id} must curate hooks`).toBeGreaterThan(0);
		}
	});

	it("every trigger is well-formed with a positive weight and known kind", () => {
		const kinds = new Set(["keyword", "regex", "extension", "path"]);
		for (const profile of Object.values(DOMAIN_PROFILES)) {
			expect(profile.triggers.length, `${profile.id} needs triggers`).toBeGreaterThan(0);
			for (const trigger of profile.triggers) {
				expect(kinds.has(trigger.kind), `${profile.id} bad kind`).toBe(true);
				expect(trigger.weight, `${profile.id} weight must be positive`).toBeGreaterThan(0);
				expect(trigger.pattern.length, `${profile.id} empty pattern`).toBeGreaterThan(0);
			}
		}
	});

	it("every regex trigger compiles to a valid RegExp", () => {
		for (const profile of Object.values(DOMAIN_PROFILES)) {
			for (const trigger of profile.triggers) {
				if (trigger.kind !== "regex") continue;
				expect(() => new RegExp(trigger.pattern, "i"), `${profile.id}: /${trigger.pattern}/`).not.toThrow();
			}
		}
	});

	it("routing prompts are detailed English briefings (non-trivial length)", () => {
		for (const profile of Object.values(DOMAIN_PROFILES)) {
			expect(profile.routingPrompt.length, `${profile.id} prompt too short`).toBeGreaterThan(300);
			expect(profile.routingPrompt).toMatch(/SEQUENCE:/);
			expect(profile.routingPrompt).toMatch(/HARD RULES:/);
		}
	});

	it("getDomainProfile returns the fallback for unknown ids", () => {
		expect(getDomainProfile("does-not-exist").id).toBe(FALLBACK_DOMAIN_ID);
		expect(getDomainProfile("frontend-ui").id).toBe("frontend-ui");
	});

	it("includes a valid grok-harness profile", () => {
		const profile = getDomainProfile("grok-harness");
		const validation = validateLoadoutProfile(profile);

		expect(profile.id).toBe("grok-harness");
		expect(profile.label).toBe("Grok xAI Harness");
		expect(profile.routingPrompt).toContain("docs/grok-harness.md");
		expect(profile.routingPrompt).toContain("optional local operator overlay");
		expect(validation.valid, validation.errors.join("; ")).toBe(true);
	});

	it("domainLoadoutProfiles strips domain-only fields and keeps loadout fields", () => {
		const loadouts = domainLoadoutProfiles();
		for (const [id, loadout] of Object.entries(loadouts)) {
			expect(loadout.schemaVersion).toBe("omk.loadout.v1");
			expect(loadout.name).toBe(id);
			// Domain-only metadata must not leak into the plain LoadoutProfile.
			expect("id" in loadout).toBe(false);
			expect("triggers" in loadout).toBe(false);
			expect("routingPrompt" in loadout).toBe(false);
		}
	});
});

describe("domain-loadouts curated inventory", () => {
	it("every builtin hook descriptor has explicit fail-closed policy metadata", () => {
		for (const hook of BUILTIN_HOOKS) {
			expect(hook.policy.failureMode, hook.name).toBe("fail-closed");
			expect(hook.policy.timeoutMs, hook.name).toBeGreaterThan(0);
			expect(hook.policy.timeoutMs, hook.name).toBeLessThanOrEqual(30_000);
			expect(hook.policy.stages.length, hook.name).toBeGreaterThan(0);
			expect(hook.policy.effects.length, hook.name).toBeGreaterThan(0);
			expect(Object.isFrozen(hook.policy), hook.name).toBe(true);
			expect(Object.isFrozen(hook.policy.stages), hook.name).toBe(true);
			expect(Object.isFrozen(hook.policy.effects), hook.name).toBe(true);
			for (const effect of hook.policy.effects) {
				expect(["validator", "mutator", "observer"], hook.name).toContain(effect);
			}
		}
	});

	it("references only the real builtin hooks", () => {
		const realHooks = new Set(BUILTIN_HOOKS.map((hook) => hook.name));
		for (const profile of Object.values(DOMAIN_PROFILES)) {
			const hooks = profile.hooks?.allow?.[0]?.names ?? [];
			for (const hook of hooks) {
				expect(realHooks.has(hook), `${profile.id} references unknown hook: ${hook}`).toBe(true);
			}
		}
	});

	it("only uses allow-gates (no exclude/require) so profiles are purely additive", () => {
		for (const profile of Object.values(DOMAIN_PROFILES)) {
			for (const gate of [profile.skills, profile.mcp, profile.hooks]) {
				if (!gate) continue;
				expect(gate.exclude ?? []).toEqual([]);
				expect(gate.require ?? []).toEqual([]);
			}
		}
	});
});

describe("algorithm-integration-v2 frontend-ui DOMAIN_PROFILES gate", () => {
	const frontendUiSkills = (): readonly string[] => getDomainProfile("frontend-ui").skills?.allow?.[0]?.names ?? [];

	it("frontend-ui skills allow-list includes taste integration pack names", () => {
		const skills = frontendUiSkills();
		for (const name of [
			"design-taste-frontend-v1",
			"brandkit",
			"imagegen-frontend-web",
			"imagegen-frontend-mobile",
		] as const) {
			expect(skills, `missing integration skill: ${name}`).toContain(name);
		}
	});

	it("frontend-ui still includes pre-existing design-taste-frontend and redesign-existing-projects", () => {
		const skills = frontendUiSkills();
		expect(skills).toContain("design-taste-frontend");
		expect(skills).toContain("redesign-existing-projects");
	});

	it("caveman does not appear in any DOMAIN_PROFILES skills allow list (opt-in only)", () => {
		for (const profile of Object.values(DOMAIN_PROFILES)) {
			const skills = profile.skills?.allow?.[0]?.names ?? [];
			expect(skills, `${profile.id} must not auto-load caveman`).not.toContain("caveman");
		}
	});
});
