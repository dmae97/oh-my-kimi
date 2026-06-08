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
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

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
	it("loads the bundled default rule set, all attributed to the provider", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.every(r => r._source.provider === BUILTIN_DEFAULTS_PROVIDER_ID)).toBe(true);
		const names = rules.map(r => r.name);
		// Name-based dedup is first-wins, so a duplicate would be silently shadowed.
		expect(new Set(names).size).toBe(names.length);
	});

	it("parses every bundled rule as a TTSR rule (non-empty condition/astCondition and scope)", async () => {
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			const conditionCount = (rule.condition?.length ?? 0) + (rule.astCondition?.length ?? 0);
			expect(conditionCount, `${rule.name} condition/astCondition`).toBeGreaterThan(0);
			expect(rule.scope?.length, `${rule.name} scope`).toBeGreaterThan(0);
		}
	});

	it("bundles ast-grep conditions for the redundant-clear-guard rule", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-redundant-clear-guard");
		expect(rule?.condition).toBeUndefined();
		expect(rule?.astCondition?.length).toBeGreaterThan(0);
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

	it("fires the no-test-timers rule on real timers in *.test.ts but not plain *.ts", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-test-timers");
		if (!rule) throw new Error("ts-no-test-timers rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		for (const snippet of ["await Bun.sleep(10)", "setTimeout(fn, 0)", "setInterval(fn, 5)"]) {
			manager.resetBuffer();
			const matches = manager.checkDelta(snippet, {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/test/foo.test.ts"],
			});
			expect(
				matches.map(r => r.name),
				snippet,
			).toEqual(["ts-no-test-timers"]);
		}

		// Same content in a non-test file is out of scope.
		manager.resetBuffer();
		expect(
			manager.checkDelta("await Bun.sleep(10)", {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/src/foo.ts"],
			}),
		).toEqual([]);
	});

	it("is the lowest-priority rule provider so user/project rules override defaults", () => {
		const { cap, provider } = ruleProvider();
		const others = cap.providers.filter(p => p.id !== BUILTIN_DEFAULTS_PROVIDER_ID);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every(p => p.priority > provider.priority)).toBe(true);
	});
});
