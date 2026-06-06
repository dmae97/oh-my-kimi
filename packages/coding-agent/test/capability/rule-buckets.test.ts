import { describe, expect, it } from "bun:test";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { bucketRules } from "@oh-my-pi/pi-coding-agent/capability/rule-buckets";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

function source(provider: string): Rule["_source"] {
	return { provider, providerName: provider, path: "/tmp/rule.md", level: "user" };
}

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "body",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		scope: partial.scope,
		interruptMode: partial.interruptMode,
		_source: partial._source ?? source("native"),
	};
}

describe("bucketRules", () => {
	it("registers a condition rule as TTSR and excludes it from rulebook/always buckets", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([ttsr], mgr);

		expect(rulebookRules).toHaveLength(0);
		expect(alwaysApplyRules).toHaveLength(0);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["no-foo"]);
	});

	it("splits non-TTSR rules into always-apply and rulebook by metadata", () => {
		const mgr = new TtsrManager();
		const sticky = makeRule({ name: "sticky", alwaysApply: true, description: "sticky desc" });
		const book = makeRule({ name: "book", description: "rulebook desc" });
		const orphan = makeRule({ name: "orphan" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([sticky, book, orphan], mgr);

		expect(alwaysApplyRules.map(r => r.name)).toEqual(["sticky"]);
		expect(rulebookRules.map(r => r.name)).toEqual(["book"]);
		expect(mgr.hasRules()).toBe(false);
	});

	it("disabledRules drops a rule from every bucket and from TTSR registration", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });
		const book = makeRule({ name: "book", description: "rulebook desc" });

		const { rulebookRules } = bucketRules([ttsr, book], mgr, { disabledRules: ["no-foo", "book"] });

		expect(rulebookRules).toHaveLength(0);
		expect(mgr.hasRules()).toBe(false);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" })).toHaveLength(0);
	});

	it("disabledRules trims entries and ignores blanks", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"] });

		bucketRules([ttsr], mgr, { disabledRules: ["  no-foo  ", "", "   "] });

		expect(mgr.hasRules()).toBe(false);
	});

	it("builtinRules:false drops builtin-defaults rules but keeps the rest", () => {
		const mgr = new TtsrManager();
		const builtin = makeRule({
			name: "builtin-foo",
			condition: ["FORBIDDEN"],
			_source: source(BUILTIN_DEFAULTS_PROVIDER_ID),
		});
		const userRule = makeRule({ name: "user-foo", condition: ["BANNED"], _source: source("native") });

		bucketRules([builtin, userRule], mgr, { builtinRules: false });

		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" })).toHaveLength(0);
		mgr.resetBuffer();
		expect(mgr.checkDelta("contains BANNED token", { source: "text" }).map(r => r.name)).toEqual(["user-foo"]);
	});

	it("includes builtin-defaults rules when builtinRules is unset (default on)", () => {
		const mgr = new TtsrManager();
		const builtin = makeRule({
			name: "builtin-foo",
			condition: ["FORBIDDEN"],
			_source: source(BUILTIN_DEFAULTS_PROVIDER_ID),
		});

		bucketRules([builtin], mgr);

		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["builtin-foo"]);
	});

	it("falls condition rules through to the rulebook when ttsr is disabled on the manager", () => {
		const mgr = new TtsrManager({
			enabled: false,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([ttsr], mgr);

		// Manager refused to register; condition rule degrades to its rulebook shape.
		expect(mgr.hasRules()).toBe(false);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" })).toEqual([]);
		expect(alwaysApplyRules.map(r => r.name)).toEqual([]);
		expect(rulebookRules.map(r => r.name)).toEqual(["no-foo"]);
	});
});
