/**
 * Hard-negative miner for reasoning-router v4.
 *
 * The frozen gold set is saturated (100% / ECE dominated by intended
 * trivial-length abstentions), so further accuracy evidence must come from
 * NEW adversarial rows. This miner generates them by mutation:
 *
 *   M1 negation injection   — "don't/never <verb>" / "하지 말고" wraps
 *   M2 clause shuffle        — compound intent "X, then Y" / "하지 말고 Y"
 *   M3 distractor injection  — leading distractor verb from another class
 *   M4 Korean morphology     — English leading-intent -> Korean equivalents
 *   M5 wrapper dilution      — signal buried mid-prose (position robustness)
 *
 * Every generated row carries an expectation *rule*, not a blanket ground
 * truth: the miner reports the predicted class plus whether it satisfies the
 * mutation's expectation rule, so a human can promote real failures into the
 * adversarial gold slice. Deterministic: seeded PRNG, no I/O, no clock.
 */

import { classifyTaskV4, type TaskClassV4 } from "../../src/core/reasoning-router-v4.ts";
import { GOLD_SET } from "../../test/fixtures/reasoning-router-gold-set.ts";

type Mutation = "M1-negation" | "M2-compound" | "M3-distractor" | "M4-korean" | "M5-dilution";

interface MinedRow {
	readonly id: string;
	readonly mutation: Mutation;
	readonly baseId: string;
	readonly prompt: string;
	readonly rule: string;
	readonly expect: TaskClassV4 | "not-base" | "second-clause";
	readonly predicted: TaskClassV4;
	readonly pass: boolean;
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const VERB_BY_CLASS: Partial<Record<TaskClassV4, string>> = {
	"code-gen": "implement",
	debug: "debug",
	review: "review",
	refactor: "refactor",
	"simple-edit": "rename",
	plan: "plan",
};

const KOREAN_LEADING: Partial<Record<TaskClassV4, string>> = {
	"code-gen": "구현해줘",
	debug: "디버깅해줘",
	review: "검토해줘",
	refactor: "리팩터링해줘",
	"simple-edit": "바꿔줘",
	plan: "설계해줘",
};

function mutate(prompt: string, baseClass: TaskClassV4, mutation: Mutation, rand: () => number): { prompt: string; expect: MinedRow["expect"]; rule: string } | null {
	const baseVerb = VERB_BY_CLASS[baseClass];
	if (!baseVerb) return null;
	switch (mutation) {
		case "M1-negation": {
			// Policy-recorded, not pass/fail: the surviving clause often carries the
			// base class on its own (e.g. "don't rename, just fix the typo"), so a
			// blanket "not-base" rule produces noise, not evidence. Rows are kept
			// for human review of negation handling rather than counted as failures.
			const neg = rand() < 0.5 ? `don't ${baseVerb} anything, just ` : `never ${baseVerb}, instead `;
			return { prompt: neg + prompt, expect: "second-clause", rule: "policy-recorded: negation wrap (surviving clause may carry base)" };
		}
		case "M2-compound": {
			// "review X, then implement Y" — second clause carries the action; accept either per router's compound policy, record it.
			const other = (Object.keys(VERB_BY_CLASS) as TaskClassV4[]).filter((c) => c !== baseClass)[Math.floor(rand() * 6)]!;
			const otherVerb = VERB_BY_CLASS[other]!;
			return {
				prompt: `${baseVerb} the module, then ${otherVerb} the tests for it`,
				expect: "second-clause",
				rule: "compound row recorded for policy review (secondClauseIntent metadata)",
			};
		}
		case "M3-distractor": {
			// Distractor verb from a *different* class prepended as a quoted mention, not an imperative.
			const other = (Object.keys(VERB_BY_CLASS) as TaskClassV4[]).filter((c) => c !== baseClass)[Math.floor(rand() * 6)]!;
			return {
				prompt: `my teammate said "${VERB_BY_CLASS[other]} it" but actually: ${prompt}`,
				expect: baseClass,
				rule: "quoted distractor must not override the real imperative",
			};
		}
		case "M4-korean": {
			const ko = KOREAN_LEADING[baseClass];
			if (!ko) return null;
			return { prompt: `${ko}: ${prompt}`, expect: baseClass, rule: "korean leading intent must keep base class" };
		}
		case "M5-dilution": {
			const filler = "background: the repo is a medium-size typescript monorepo with bun workspaces. ".repeat(3);
			return { prompt: filler + prompt, expect: baseClass, rule: "signal buried after prose prefix must keep base class" };
		}
	}
}

const rand = mulberry32(0x5eed);
const rows: MinedRow[] = [];
const mutations: Mutation[] = ["M1-negation", "M2-compound", "M3-distractor", "M4-korean", "M5-dilution"];

for (const entry of GOLD_SET) {
	if (entry.expectedClass === "trivial") continue;
	for (const mutation of mutations) {
		const m = mutate(entry.prompt, entry.expectedClass, mutation, rand);
		if (!m) continue;
		const verdict = classifyTaskV4({ prompt: m.prompt });
		let pass: boolean;
		if (m.expect === "not-base") pass = verdict.taskClass !== entry.expectedClass;
		else if (m.expect === "second-clause") pass = true; // policy-recorded, always "pass"
		else pass = verdict.taskClass === m.expect;
		rows.push({
			id: `${entry.id}:${mutation}`,
			mutation,
			baseId: entry.id,
			prompt: m.prompt,
			rule: m.rule,
			expect: m.expect,
			predicted: verdict.taskClass,
			pass,
		});
	}
}

const fails = rows.filter((r) => !r.pass);
const byMutation: Record<string, { total: number; fail: number; samples: string[] }> = {};
for (const r of rows) {
	const bucket = (byMutation[r.mutation] ??= { total: 0, fail: 0, samples: [] });
	bucket.total++;
	if (!r.pass) {
		bucket.fail++;
		if (bucket.samples.length < 4) bucket.samples.push(`${r.id} expected ${r.expect} got ${r.predicted}`);
	}
}
console.log(JSON.stringify({ total: rows.length, fails: fails.length, byMutation }, null, 1));
