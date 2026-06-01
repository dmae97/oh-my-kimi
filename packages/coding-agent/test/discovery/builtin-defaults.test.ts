/**
 * The bundled `builtin-defaults` rule provider ships a curated default rule set
 * embedded into the binary. These tests defend that the whole set loads and
 * parses, and that the provider sits at the lowest priority so any user/project
 * rule of the same name overrides a bundled default (first-wins dedup).
 */
import { describe, expect, it } from "bun:test";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";

const EXPECTED_RULE_NAMES = [
	"rs-box-leak",
	"rs-future-prelude",
	"rs-lazylock",
	"rs-match-ergonomics",
	"rs-parking-lot",
	"rs-result-type",
	"ts-bare-catch",
	"ts-import-type",
	"ts-no-any",
	"ts-no-dynamic-import",
	"ts-no-return-type",
	"ts-no-tiny-functions",
	"ts-promise-with-resolvers",
	"ts-set-map",
].sort();

function ruleProvider() {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const provider = cap.providers.find(p => p.id === BUILTIN_DEFAULTS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-defaults provider missing");
	return { cap, provider };
}

async function loadBuiltinRules(): Promise<Rule[]> {
	const { provider } = ruleProvider();
	const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
	const result = await (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

describe("builtin-defaults rule provider", () => {
	it("loads exactly the bundled default rule set, all attributed to the provider", async () => {
		const rules = await loadBuiltinRules();
		const names = rules.map(r => r.name).sort();
		expect(names).toEqual(EXPECTED_RULE_NAMES);
		expect(rules.every(r => r._source.provider === BUILTIN_DEFAULTS_PROVIDER_ID)).toBe(true);
	});

	it("parses every bundled rule as a TTSR rule (non-empty condition and scope)", async () => {
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			expect(rule.condition?.length, `${rule.name} condition`).toBeGreaterThan(0);
			expect(rule.scope?.length, `${rule.name} scope`).toBeGreaterThan(0);
		}
	});

	it("parses YAML list-form conditions from the embedded text", async () => {
		const rules = await loadBuiltinRules();
		const lazylock = rules.find(r => r.name === "rs-lazylock");
		// Frontmatter declares two condition patterns as a YAML sequence.
		expect(lazylock?.condition).toHaveLength(2);
	});

	it("preserves a per-rule interruptMode override from frontmatter", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.find(r => r.name === "ts-set-map")?.interruptMode).toBe("never");
	});

	it("is the lowest-priority rule provider so user/project rules override defaults", () => {
		const { cap, provider } = ruleProvider();
		const others = cap.providers.filter(p => p.id !== BUILTIN_DEFAULTS_PROVIDER_ID);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every(p => p.priority > provider.priority)).toBe(true);
	});
});
