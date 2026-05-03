/**
 * Bank ID derivation, project-tag scoping, and first-use mission setup.
 *
 * Three scoping modes (`HindsightConfig.scoping`):
 *   - `global`              — single shared bank, no per-project filter.
 *   - `per-project`         — one bank per cwd basename, hard isolation.
 *   - `per-project-tagged`  — single shared bank, retains carry a `project:<name>`
 *                              tag and recall filters on it but still surfaces
 *                              untagged ("global") memories alongside.
 *
 * The base bank id is `bankIdPrefix-bankId` (default `omp`). Per-project mode
 * appends `-<project>`; tagged mode leaves the bank untouched and uses tags.
 *
 * Mission setup is idempotent at module level — a missionsSet keeps track of
 * banks we've already POSTed to so each session boundary doesn't fire a fresh
 * `createBank` call. Failures are swallowed: missions are an optimisation, not
 * a precondition for retain/recall.
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { HindsightClient } from "@vectorize-io/hindsight-client";
import type { HindsightConfig } from "./config";

const DEFAULT_BANK_NAME = "omp";
const PROJECT_TAG_PREFIX = "project:";
const UNKNOWN_PROJECT = "unknown";
const MISSION_SET_CAP = 10_000;

export type RecallTagsMatch = "any" | "all" | "any_strict" | "all_strict";

/**
 * Resolved bank target for a session: which bank to talk to, plus optional
 * tags to attach to retains and to filter recalls by.
 */
export interface BankScope {
	bankId: string;
	/** Tags applied to every retain. Undefined when scoping does not use tags. */
	retainTags?: string[];
	/** Tags filter for recall/reflect. Undefined when scoping does not use tags. */
	recallTags?: string[];
	/** Match mode for `recallTags`. Defaults to `any` so untagged ("global") memories surface too. */
	recallTagsMatch?: RecallTagsMatch;
}

/** Compose the prefixed base bank id (no project segment). */
function baseBankId(config: HindsightConfig): string {
	const base = config.bankId?.trim() || DEFAULT_BANK_NAME;
	const prefix = config.bankIdPrefix?.trim() || "";
	return prefix ? `${prefix}-${base}` : base;
}

/** Best-effort project label from a working-directory path. */
function projectLabel(directory: string): string {
	if (!directory) return UNKNOWN_PROJECT;
	return path.basename(directory) || UNKNOWN_PROJECT;
}

/**
 * Resolve the active bank target plus optional tag scoping.
 *
 * Always returns a non-empty `bankId`. Tag fields are populated only for
 * `per-project-tagged`.
 */
export function computeBankScope(config: HindsightConfig, directory: string): BankScope {
	const base = baseBankId(config);
	switch (config.scoping) {
		case "global":
			return { bankId: base };
		case "per-project":
			return { bankId: `${base}-${projectLabel(directory)}` };
		case "per-project-tagged": {
			const tag = `${PROJECT_TAG_PREFIX}${projectLabel(directory)}`;
			return {
				bankId: base,
				retainTags: [tag],
				recallTags: [tag],
				// `any` keeps untagged "global" memories visible alongside the
				// project-tagged ones; flip to `*_strict` to harden isolation.
				recallTagsMatch: "any",
			};
		}
	}
}

/**
 * Backwards-compatible thin wrapper: just return the bank id portion of the
 * scope. New code should prefer `computeBankScope` directly so it can also
 * apply the tag fields.
 */
export function deriveBankId(config: HindsightConfig, directory: string): string {
	return computeBankScope(config, directory).bankId;
}

/**
 * Ensure a bank's reflect/retain mission is set, exactly once per process.
 *
 * Tracked via the supplied set; on overflow we drop the oldest half so the set
 * cannot grow unboundedly across long-lived processes.
 */
export async function ensureBankMission(
	client: HindsightClient,
	bankId: string,
	config: HindsightConfig,
	missionsSet: Set<string>,
): Promise<void> {
	const mission = config.bankMission?.trim();
	if (!mission) return;
	if (missionsSet.has(bankId)) return;

	try {
		await client.createBank(bankId, {
			reflectMission: mission,
			retainMission: config.retainMission?.trim() || undefined,
		});
		missionsSet.add(bankId);
		if (missionsSet.size > MISSION_SET_CAP) {
			const keys = [...missionsSet].sort();
			for (const key of keys.slice(0, keys.length >> 1)) {
				missionsSet.delete(key);
			}
		}
		if (config.debug) {
			logger.debug("Hindsight: set mission for bank", { bankId });
		}
	} catch (err) {
		// Mission set is best-effort; the bank may not exist yet, or the API may
		// reject the call. Either way, retain/recall still work, so swallow.
		logger.debug("Hindsight: ensureBankMission failed", { bankId, error: String(err) });
	}
}
