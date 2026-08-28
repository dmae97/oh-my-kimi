import { describe, expect, it } from "vitest";
import { BIAS_MAX_STEPS, BIAS_STRONG_THRESHOLD } from "../src/core/reasoning-router-bias.ts";
import { REASONING_LADDER, TASK_CLASS_THINKING_LEVELS } from "../src/core/reasoning-router-resolver.ts";
import { deriveRouterFeedbackFeaturesV4 } from "../src/core/reasoning-router-v4.ts";
import { GOLD_SET } from "./fixtures/reasoning-router-gold-set.ts";

/**
 * Ceiling of the router's level-policy space on the gold set.
 *
 * Two layers decide reasoning effort: a task-class -> ThinkingLevel table, and a
 * per-cell bias that nudges that base by up to `BIAS_MAX_STEPS` once a cell has
 * `BIAS_STRONG_THRESHOLD` supporting records. These tests pin how much a
 * *learned* policy could win over the shipped one in either layer.
 *
 * They score against the gold set's `expectedClass`, holding the classifier
 * constant so the policy is the only variable. The answer for both layers is
 * currently zero, which is why router policy learning has nothing to promote:
 * the instrument cannot evidence an improvement that does not exist in it.
 */

/** `[taskClass, frozenLevel]` pairs, read straight off the shipped table. */
const FROZEN_ENTRIES = Object.entries(TASK_CLASS_THINKING_LEVELS);

/** Rows in `taskClass` whose ideal level equals `level`. */
function hitsFor(taskClass: string, level: string): number {
	return GOLD_SET.filter((row) => row.expectedClass === taskClass && row.expectedLevel === level).length;
}

/** The most rows any single level choice can win for this class. */
function bestPossibleHits(taskClass: string): number {
	return Math.max(...REASONING_LADDER.map((level) => hitsFor(taskClass, level)));
}

function totalFrozenHits(): number {
	return FROZEN_ENTRIES.reduce((sum, [taskClass, level]) => sum + hitsFor(taskClass, level), 0);
}

describe("frozen task-class level table", () => {
	it("covers every class the gold set labels", () => {
		const labeled = [...new Set(GOLD_SET.map((row) => row.expectedClass))].sort();
		const tabled = FROZEN_ENTRIES.map(([taskClass]) => taskClass).sort();

		expect(labeled).toEqual(tabled);
	});

	it("picks a level no alternative choice can beat, for every class", () => {
		for (const [taskClass, level] of FROZEN_ENTRIES) {
			expect({ class: taskClass, hits: hitsFor(taskClass, level) }).toEqual({
				class: taskClass,
				hits: bestPossibleHits(taskClass),
			});
		}
	});

	it("is optimal within the class-to-level hypothesis space on the gold set", () => {
		// Classes score independently, so the sum of per-class maxima is the
		// ceiling for ANY table. Matching it means no learned table wins here.
		const ceiling = FROZEN_ENTRIES.reduce((sum, [taskClass]) => sum + bestPossibleHits(taskClass), 0);

		expect(totalFrozenHits()).toBe(ceiling);
	});

	it("leaves residual error that no class-to-level table can reach", () => {
		// The unreachable rows are those whose ideal level differs from their own
		// class's best single level. Winning them needs signal beyond the class
		// label. Whether the bias layer carries that signal is the next suite.
		expect(totalFrozenHits()).toBeLessThan(GOLD_SET.length);
	});
});

/** Bias cell key: the exact tuple `reasoning-router-bias.ts` learns over, minus runtime lane. */
function cellKeyFor(row: (typeof GOLD_SET)[number]): string {
	const features = deriveRouterFeedbackFeaturesV4(row.prompt);
	return `${row.expectedClass}|${features.lenBucket}|${features.hadFence}|${features.hadDiff}`;
}

function groupByCell(): Map<string, (typeof GOLD_SET)[number][]> {
	const cells = new Map<string, (typeof GOLD_SET)[number][]>();
	for (const row of GOLD_SET) {
		const key = cellKeyFor(row);
		cells.set(key, [...(cells.get(key) ?? []), row]);
	}
	return cells;
}

/** Best hits a cell can win with one level within `BIAS_MAX_STEPS` of its class base. */
function bestBoundedHits(rows: (typeof GOLD_SET)[number][]): number {
	const first = rows[0];
	if (!first) return 0;
	const base = REASONING_LADDER.indexOf(TASK_CLASS_THINKING_LEVELS[first.expectedClass]);
	const reachable = REASONING_LADDER.filter(
		(level) => Math.abs(REASONING_LADDER.indexOf(level) - base) <= BIAS_MAX_STEPS,
	);
	return Math.max(...reachable.map((level) => rows.filter((row) => row.expectedLevel === level).length));
}

/** Hits the cell contributes under the shipped policy (no bias applied). */
function frozenHitsIn(rows: (typeof GOLD_SET)[number][]): number {
	return rows.filter((row) => TASK_CLASS_THINKING_LEVELS[row.expectedClass] === row.expectedLevel).length;
}

describe("per-cell bias layer", () => {
	it("wins nothing once its own support threshold is applied", () => {
		// A cell may only bias after `BIAS_STRONG_THRESHOLD` supporting records.
		// Cells below that keep the frozen level no matter what the labels say, so
		// the achievable score is the bounded best for firable cells plus the
		// frozen score everywhere else.
		const achievable = [...groupByCell().values()].reduce(
			(sum, rows) => sum + (rows.length >= BIAS_STRONG_THRESHOLD ? bestBoundedHits(rows) : frozenHitsIn(rows)),
			0,
		);

		expect(achievable).toBe(totalFrozenHits());
	});

	it("concentrates its winnable rows in cells too small to ever fire", () => {
		// With unlimited support the feature tuple would win a little; the reason
		// it wins nothing in practice is that those rows sit under the threshold.
		const cells = [...groupByCell().values()];
		const unlimited = cells.reduce((sum, rows) => sum + bestBoundedHits(rows), 0);

		expect(unlimited).toBeGreaterThan(totalFrozenHits());
	});
});
