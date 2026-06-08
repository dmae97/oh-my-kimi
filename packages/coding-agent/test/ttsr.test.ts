import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseRuleConditionAndScope, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { TtsrSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EDIT_MODE_STRATEGIES } from "@oh-my-pi/pi-coding-agent/edit";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

function ttsrManager(overrides: Partial<TtsrSettings> = {}): TtsrManager {
	return new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		...overrides,
	});
}

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "Do not use as any",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		astCondition: partial.astCondition,
		scope: partial.scope,
		_source: partial._source ?? {
			provider: "test",
			providerName: "test",
			path: "/tmp/rule.md",
			level: "project",
		},
	};
}

describe("parseRuleConditionAndScope", () => {
	it("accepts condition and scope as literal strings", () => {
		const parsed = parseRuleConditionAndScope({
			condition: "\\bas any\\b",
			scope: "tool:edit",
		});

		expect(parsed.condition).toEqual(["\\bas any\\b"]);
		expect(parsed.scope).toEqual(["tool:edit"]);
	});

	it("accepts condition and scope as arrays", () => {
		const parsed = parseRuleConditionAndScope({
			condition: ["foo", "bar"],
			scope: ["tool:edit", "tool:write"],
		});

		expect(parsed.condition).toEqual(["foo", "bar"]);
		expect(parsed.scope).toEqual(["tool:edit", "tool:write"]);
	});

	it("accepts legacy ttsr_trigger as condition fallback", () => {
		const parsed = parseRuleConditionAndScope({
			ttsr_trigger: "forbidden",
		});

		expect(parsed.condition).toEqual(["forbidden"]);
		expect(parsed.scope).toBeUndefined();
	});

	it("accepts legacy ttsrTrigger as condition fallback", () => {
		const parsed = parseRuleConditionAndScope({
			ttsrTrigger: "legacy-camel-case",
		});

		expect(parsed.condition).toEqual(["legacy-camel-case"]);
		expect(parsed.scope).toBeUndefined();
	});

	it("keeps regex-like conditions as regex and does not infer file scope", () => {
		const parsed = parseRuleConditionAndScope({
			condition: "error.*timeout",
		});

		expect(parsed.condition).toEqual(["error.*timeout"]);
		expect(parsed.scope).toBeUndefined();
	});

	it("splits comma-delimited scope without corrupting brace globs", () => {
		const parsed = parseRuleConditionAndScope({
			scope: "text, tool:edit(*.{ts,tsx})",
		});

		expect(parsed.condition).toBeUndefined();
		expect(parsed.scope).toEqual(["text", "tool:edit(*.{ts,tsx})"]);
	});

	it("maps glob-like condition to edit/write scoped shorthand", () => {
		const parsed = parseRuleConditionAndScope({
			condition: "*.rs",
		});

		expect(parsed.condition).toEqual([".*"]);
		expect(parsed.scope).toEqual(["tool:edit(*.rs)", "tool:write(*.rs)"]);
	});

	it("normalizes astCondition strings and arrays without glob inference", () => {
		expect(parseRuleConditionAndScope({ astCondition: "console.log($A)" }).astCondition).toEqual(["console.log($A)"]);
		const parsed = parseRuleConditionAndScope({
			astCondition: ["console.log($A)", "debugger"],
		});
		expect(parsed.astCondition).toEqual(["console.log($A)", "debugger"]);
		// AST patterns never drive scope inference, and absent regex stays absent.
		expect(parsed.condition).toBeUndefined();
		expect(parsed.scope).toBeUndefined();
	});

	it("carries astCondition alongside a regex condition", () => {
		const parsed = parseRuleConditionAndScope({
			condition: "TODO",
			astCondition: "console.log($A)",
		});
		expect(parsed.condition).toEqual(["TODO"]);
		expect(parsed.astCondition).toEqual(["console.log($A)"]);
	});
});

describe("TtsrManager scope matching", () => {
	it("applies file-scoped tool rules without cross-language contamination", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "ts-no-as-any",
			condition: ["\\bas any\\b"],
			scope: ["tool:edit(*.ts)", "tool:write(*.ts)"],
		});

		manager.addRule(rule);

		expect(
			manager.checkDelta("as any", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([rule]);

		expect(
			manager.checkDelta("as any", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.rs"],
			}),
		).toEqual([]);

		expect(
			manager.checkDelta("as any", {
				source: "text",
			}),
		).toEqual([]);
	});

	it("treats bare tool names as specific tools, not as the generic tool scope", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "tooling-only",
			condition: ["forbidden"],
			scope: ["tooling"],
		});

		manager.addRule(rule);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
			}),
		).toEqual([]);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "tooling",
			}),
		).toEqual([rule]);
	});

	it("preserves path glob casing in tool scope matching", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "upper-ext-only",
			condition: ["forbidden"],
			scope: ["tool:edit(*.TS)"],
		});

		manager.addRule(rule);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([]);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.TS"],
			}),
		).toEqual([rule]);
	});

	it("returns false when registering rules with only invalid condition regex", () => {
		const manager = new TtsrManager();
		const added = manager.addRule(
			makeRule({
				name: "invalid-regex",
				condition: ["("],
			}),
		);

		expect(added).toBe(false);
	});

	it("returns false when registering rules with unreachable malformed scope", () => {
		const manager = new TtsrManager();
		const added = manager.addRule(
			makeRule({
				name: "invalid-scope",
				condition: ["forbidden"],
				scope: ["tool:edit(*.ts"],
			}),
		);

		expect(added).toBe(false);
		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([]);
	});

	it("matches write scope and rejects thinking/tool mismatches for the same rule", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "ts-no-write-as-any",
			condition: ["\\bas any\\b"],
			scope: ["tool:write(*.ts)"],
		});

		manager.addRule(rule);

		expect(
			manager.checkDelta("as any", {
				source: "tool",
				toolName: "write",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([rule]);
		expect(
			manager.checkDelta("as any", {
				source: "thinking",
			}),
		).toEqual([]);
		expect(
			manager.checkDelta("as any", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([]);
	});

	it("matches file-scoped rules across relative and absolute path variants", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "variant-paths",
			condition: ["forbidden"],
			scope: ["tool:edit(*.ts)"],
		});
		const absolutePath = path.resolve("/tmp", "src", "main.ts");

		manager.addRule(rule);

		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["./src/main.ts"],
			}),
		).toEqual([rule]);
		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/main.ts"],
			}),
		).toEqual([rule]);
		expect(
			manager.checkDelta("forbidden", {
				source: "tool",
				toolName: "edit",
				filePaths: [absolutePath],
			}),
		).toEqual([rule]);
	});
});

describe("TtsrManager enabled gate", () => {
	it("rejects registration when ttsr is disabled", () => {
		const manager = ttsrManager({ enabled: false });
		const rule = makeRule({
			name: "no-foo",
			condition: ["FORBIDDEN"],
			scope: ["text"],
		});

		expect(manager.addRule(rule)).toBe(false);
	});

	it("reports no rules when ttsr is disabled, even after a registration attempt", () => {
		const manager = ttsrManager({ enabled: false });
		manager.addRule(
			makeRule({
				name: "no-foo",
				condition: ["FORBIDDEN"],
				scope: ["text"],
			}),
		);

		expect(manager.hasRules()).toBe(false);
	});

	it("returns no matches from stream deltas when ttsr is disabled", () => {
		const manager = ttsrManager({ enabled: false });

		expect(manager.checkDelta("contains FORBIDDEN token", { source: "text" })).toEqual([]);
		expect(manager.checkDelta("FORBIDDEN", { source: "tool", toolName: "edit" })).toEqual([]);
	});

	it("preserves the default (enabled) registration and matching contract", () => {
		const manager = ttsrManager();
		const rule = makeRule({
			name: "no-foo",
			condition: ["FORBIDDEN"],
			scope: ["text"],
		});

		expect(manager.addRule(rule)).toBe(true);
		expect(manager.hasRules()).toBe(true);
		expect(manager.checkDelta("FORBIDDEN", { source: "text" })).toEqual([rule]);
	});
});

describe("TtsrManager snapshot matching", () => {
	it("matches source-level conditions against a tool digest where the raw patch grammar fails", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "ts-no-tiny-functions",
			condition: ["\\{\\s*return [^;{}\\n]+;?\\s*\\}"],
			scope: ["tool:edit(*.ts)"],
		});
		manager.addRule(rule);

		const context = {
			source: "tool" as const,
			toolName: "edit",
			filePaths: ["src/repo.ts"],
			streamKey: "toolcall:tc-1",
		};
		const patch = [
			"[src/repo.ts#AB12]",
			"replace block 1:",
			"+export async function isRepository(cwd: string): Promise<boolean> {",
			"+\treturn repo.isRepository(cwd);",
			"+}",
			"",
		].join("\n");

		// Raw patch grammar: `+` body-row prefixes break source-level regexes.
		expect(manager.checkDelta(patch, context)).toEqual([]);

		// The edit tool's digest of the same patch is real source text and matches.
		const digest = EDIT_MODE_STRATEGIES.hashline.matcherDigest({ input: patch });
		expect(digest).toBe(
			[
				"export async function isRepository(cwd: string): Promise<boolean> {",
				"\treturn repo.isRepository(cwd);",
				"}",
			].join("\n"),
		);
		expect(manager.checkSnapshot(digest as string, context)).toEqual([rule]);
	});

	it("replaces the scoped buffer instead of appending snapshots", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "no-as-any",
			condition: ["as any"],
			scope: ["tool:edit(*.ts)"],
		});
		manager.addRule(rule);

		const context = {
			source: "tool" as const,
			toolName: "edit",
			filePaths: ["src/main.ts"],
			streamKey: "toolcall:tc-2",
		};

		expect(manager.checkSnapshot("const x = y as any;", context)).toEqual([rule]);
		// A later digest without the pattern must not match stale buffered text.
		expect(manager.checkSnapshot("const x = y as string;", context)).toEqual([]);
	});
});

describe("TtsrManager ast condition matching", () => {
	const editContext = {
		source: "tool" as const,
		toolName: "edit",
		filePaths: ["src/main.ts"],
		streamKey: "toolcall:ast-1",
	};

	it("registers and reports ast-only rules without a regex condition", () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "no-console", astCondition: ["console.log($A)"] });

		expect(manager.addRule(rule)).toBe(true);
		expect(manager.hasRules()).toBe(true);
		expect(manager.hasAstRules()).toBe(true);
	});

	it("does not report ast rules when only regex conditions are registered", () => {
		const manager = new TtsrManager();
		manager.addRule(makeRule({ name: "regex-only", condition: ["TODO"], scope: ["text"] }));
		expect(manager.hasAstRules()).toBe(false);
	});

	it("matches an ast pattern against a reconstructed source snapshot", async () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "no-console",
			astCondition: ["console.log($A)"],
			scope: ["tool:edit(*.ts)"],
		});
		manager.addRule(rule);

		const matches = await manager.checkAstSnapshot('function greet() {\n\tconsole.log("hi");\n}', editContext);
		expect(matches).toEqual([rule]);
	});

	it("does not match when the ast pattern is absent", async () => {
		const manager = new TtsrManager();
		manager.addRule(makeRule({ name: "no-console", astCondition: ["console.log($A)"] }));

		const matches = await manager.checkAstSnapshot("function greet() {\n\treturn 1;\n}", editContext);
		expect(matches).toEqual([]);
	});

	it("infers language from the file extension and isolates other languages", async () => {
		const manager = new TtsrManager();
		manager.addRule(makeRule({ name: "no-console", astCondition: ["console.log($A)"], scope: ["tool:edit(*.ts)"] }));

		// A `.rs` path is out of the rule's tool scope, so the TS pattern never runs.
		const rustMatches = await manager.checkAstSnapshot('println!("{}", x);', {
			...editContext,
			filePaths: ["src/main.rs"],
			streamKey: "toolcall:ast-rs",
		});
		expect(rustMatches).toEqual([]);
	});

	it("skips ast evaluation when no file path is available to infer a language", async () => {
		const manager = new TtsrManager();
		manager.addRule(makeRule({ name: "no-console", astCondition: ["console.log($A)"] }));

		const matches = await manager.checkAstSnapshot('console.log("hi");', {
			source: "tool",
			toolName: "edit",
			streamKey: "toolcall:ast-nopath",
		});
		expect(matches).toEqual([]);
	});

	it("evaluates ast conditions only once for an unchanged snapshot", async () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "no-console", astCondition: ["console.log($A)"] });
		manager.addRule(rule);
		const snapshot = 'console.log("hi");';

		// First evaluation matches; the throttle returns nothing for the identical re-check.
		expect(await manager.checkAstSnapshot(snapshot, editContext)).toEqual([rule]);
		expect(await manager.checkAstSnapshot(snapshot, editContext)).toEqual([]);
	});

	it("returns no ast matches when ttsr is disabled", async () => {
		const manager = ttsrManager({ enabled: false });
		manager.addRule(makeRule({ name: "no-console", astCondition: ["console.log($A)"] }));

		expect(manager.hasAstRules()).toBe(false);
		expect(await manager.checkAstSnapshot('console.log("hi");', editContext)).toEqual([]);
	});
});

describe("TtsrManager repeat behavior", () => {
	const turnContext = { source: "text" as const };

	function createRepeatRule(name = "repeat-rule"): Rule {
		return makeRule({
			name,
			condition: ["forbidden"],
			scope: ["text"],
		});
	}

	function runTurn(manager: TtsrManager, rule: Rule): Rule[] {
		manager.resetBuffer();
		const matches = manager.checkDelta("forbidden", turnContext);
		if (matches.length > 0) {
			manager.markInjected([rule]);
		}
		manager.incrementMessageCount();
		return matches;
	}

	it("never repeats when repeat mode is once", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		const rule = createRepeatRule("once");
		manager.addRule(rule);

		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([]);
	});

	it("repeats every turn when repeat mode is after-gap and gap is 1", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 1,
		});
		const rule = createRepeatRule("gap-1");
		manager.addRule(rule);

		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([rule]);
	});

	it("respects repeat gap when repeat mode is after-gap", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 2,
		});
		const rule = createRepeatRule("gap-2");
		manager.addRule(rule);

		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([rule]);
		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([rule]);
	});

	it("blocks restored rules in once mode across resumed sessions", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		const rule = createRepeatRule("restored-once");
		manager.addRule(rule);
		manager.restoreInjected([rule.name]);

		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([]);
	});

	it("applies repeat gap to restored rules in after-gap mode", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 2,
		});
		const rule = createRepeatRule("restored-gap");
		manager.addRule(rule);
		manager.restoreInjected([rule.name]);

		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([]);
		expect(runTurn(manager, rule)).toEqual([rule]);
	});

	it("tracks only one injection record per rule per turn", () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 1,
		});
		const rule = createRepeatRule("single-record");
		manager.addRule(rule);

		manager.markInjected([rule]);
		manager.markInjected([rule]);
		manager.markInjected([rule]);
		expect(manager.getInjectedRuleNames()).toEqual([rule.name]);

		manager.incrementMessageCount();
		expect(manager.checkDelta("forbidden", turnContext)).toEqual([rule]);
	});
});
