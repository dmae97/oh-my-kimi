/**
 * Bank ID derivation and first-use mission setup.
 *
 * Static mode: bank id is `${prefix}${configured-or-default}`.
 * Dynamic mode: composed from a fixed granularity tuple
 *   (`agent::project::channel::user`) joined by `::`.
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
const DYNAMIC_BANK_FIELDS = ["agent", "project", "channel", "user"] as const;
const MISSION_SET_CAP = 10_000;

/**
 * Derive a bank id for the given working directory and config.
 *
 * Always returns a non-empty string. Missing channel/user env vars fall back
 * to `default`/`anonymous` so we always end up with a stable, dotted id.
 */
export function deriveBankId(config: HindsightConfig, directory: string): string {
	const prefix = config.bankIdPrefix ?? "";
	const join = (base: string) => (prefix ? `${prefix}-${base}` : base);

	if (!config.dynamicBankId) {
		return join(config.bankId?.trim() || DEFAULT_BANK_NAME);
	}

	const channelId = process.env.HINDSIGHT_CHANNEL_ID || "";
	const userId = process.env.HINDSIGHT_USER_ID || "";

	const fieldMap: Record<(typeof DYNAMIC_BANK_FIELDS)[number], string> = {
		agent: config.agentName?.trim() || DEFAULT_BANK_NAME,
		project: directory ? path.basename(directory) || "unknown" : "unknown",
		channel: channelId || "default",
		user: userId || "anonymous",
	};

	return join(DYNAMIC_BANK_FIELDS.map(f => fieldMap[f] || "unknown").join("::"));
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
