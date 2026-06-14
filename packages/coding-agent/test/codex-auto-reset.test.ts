/**
 * Decision-predicate fixtures for Codex saved-reset auto-redeem. Pure and
 * offline — no `redeemResetCredit`, no `fetch`, no credit is ever spent. Each
 * case asserts the exact skip reason (or a `redeem: true` payload) so a future
 * change to one gate can't silently flip another.
 *
 * The deciding window is the WEEKLY (`openai-codex:secondary`) limit: a saved
 * reset applies to the weekly quota, so a 5h-only block (weekly still has
 * headroom) must never spend a credit — it self-heals within the hour.
 */
import { describe, expect, it } from "bun:test";
import type { OAuthAccountIdentity, UsageReport } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	type CodexAutoRedeemInput,
	DEBOUNCE_BUCKET_MS,
	evaluateCodexAutoRedeem,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";

// Epoch ms divisible by 60_000 so a minute-boundary `resetsAt` lets the
// debounce-jitter cases reason about bucket crossings precisely.
const NOW = 1_700_000_040_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ACCOUNT_ID = "acct-123";
const EMAIL = "user@example.com";
const IDENTITY: OAuthAccountIdentity = { accountId: ACCOUNT_ID, email: EMAIL };

interface ReportOpts {
	limitReached?: boolean;
	fetchedAgoMs?: number;
	accountId?: string;
	email?: string;
	/** Primary (5h) usedFraction — the predicate must IGNORE it. Defaults to exhausted. */
	primaryUsed?: number;
	/** Omit the weekly window's `resetsAt` entirely. */
	omitResetTime?: boolean;
}

/**
 * Build a synthetic openai-codex `UsageReport`. `weeklyUsed === undefined`
 * omits the weekly limit (provider didn't report it); `credits === undefined`
 * omits `resetCredits` (older broker / parse failure). The primary 5h window
 * is always present with a nearby reset so any accidental dependence on it
 * would surface as a wrong decision.
 */
function report(
	weeklyUsed: number | undefined,
	resetInMs: number,
	credits: number | undefined,
	opts: ReportOpts = {},
): UsageReport {
	const accountId = opts.accountId ?? ACCOUNT_ID;
	const email = opts.email ?? EMAIL;
	const limits: UsageReport["limits"] = [
		{
			id: "openai-codex:primary",
			label: "5 Hour",
			scope: { provider: "openai-codex", accountId },
			window: { id: "5h", label: "5 Hour", resetsAt: NOW + 2 * HOUR },
			amount: { usedFraction: opts.primaryUsed ?? 1.0, unit: "percent" },
		},
	];
	if (weeklyUsed !== undefined) {
		limits.push({
			id: "openai-codex:secondary",
			label: "Weekly",
			scope: { provider: "openai-codex", accountId },
			window: { id: "7d", label: "Weekly", ...(opts.omitResetTime ? {} : { resetsAt: NOW + resetInMs }) },
			amount: { usedFraction: weeklyUsed, unit: "percent" },
		});
	}
	return {
		provider: "openai-codex",
		fetchedAt: NOW - (opts.fetchedAgoMs ?? 0),
		limits,
		resetCredits: credits === undefined ? undefined : { availableCount: credits },
		metadata: { accountId, email, limitReached: opts.limitReached ?? true },
	};
}

/** Build a predicate input around a report, with overridable knobs. */
function input(reports: UsageReport[] | null, overrides: Partial<CodexAutoRedeemInput> = {}): CodexAutoRedeemInput {
	return {
		nowMs: NOW,
		provider: "openai-codex",
		modelId: "gpt-5.3-codex",
		settings: { autoRedeem: true, minBlockedMinutes: 60, keepCredits: 0 },
		identity: IDENTITY,
		reports,
		attemptedBlockKeys: new Set<string>(),
		lastAttemptAtByAccount: new Map<string, number>(),
		...overrides,
	};
}

describe("evaluateCodexAutoRedeem", () => {
	it("redeems a weekly-only block (5h has headroom) far from the natural reset", () => {
		const resetsAt = NOW + 3 * DAY;
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, 1, { primaryUsed: 0.62 })]));
		expect(decision).toEqual({
			redeem: true,
			target: { accountId: ACCOUNT_ID, email: EMAIL },
			accountKey: ACCOUNT_ID,
			blockKey: `${ACCOUNT_ID}|${Math.round(resetsAt / DEBOUNCE_BUCKET_MS)}`,
			weeklyResetAtMs: resetsAt,
			remainingMs: 3 * DAY,
			availableCount: 1,
		});
	});

	it("redeems when both windows are exhausted (primary state is irrelevant)", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, 1, { primaryUsed: 1.0 })]));
		expect(decision).toMatchObject({ redeem: true, weeklyResetAtMs: NOW + 3 * DAY });
	});

	it("redeems at exactly the 0.999 exhaustion threshold", () => {
		const decision = evaluateCodexAutoRedeem(input([report(0.999, 3 * DAY, 1)]));
		expect(decision).toMatchObject({ redeem: true });
	});

	it("skips a 5h-only block (weekly has headroom — the credit would buy nothing)", () => {
		const decision = evaluateCodexAutoRedeem(input([report(0.4, 3 * DAY, 1, { primaryUsed: 1.0 })]));
		expect(decision).toEqual({ redeem: false, reason: "weekly-not-exhausted" });
	});

	it("skips when the weekly window is nearly but not fully exhausted", () => {
		const decision = evaluateCodexAutoRedeem(input([report(0.995, 3 * DAY, 1)]));
		expect(decision).toEqual({ redeem: false, reason: "weekly-not-exhausted" });
	});

	it("skips when the provider omitted the weekly limit", () => {
		const decision = evaluateCodexAutoRedeem(input([report(undefined, 3 * DAY, 1)]));
		expect(decision).toEqual({ redeem: false, reason: "weekly-not-exhausted" });
	});

	it("skips when the wire flag does not confirm the block", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, 1, { limitReached: false })]));
		expect(decision).toEqual({ redeem: false, reason: "not-limit-reached" });
	});

	it("skips when the natural weekly reset is only minutes away", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 2 * 60_000, 1)]));
		expect(decision).toEqual({ redeem: false, reason: "reset-too-soon" });
	});

	it("skips a reset already in the past (treated as too-soon)", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, -60_000, 1)]));
		expect(decision).toEqual({ redeem: false, reason: "reset-too-soon" });
	});

	it("skips an implausibly distant reset (more than one window length away)", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 8 * DAY, 1)]));
		expect(decision).toEqual({ redeem: false, reason: "reset-implausible" });
	});

	it("skips when the weekly window has no reset timestamp", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, 1, { omitResetTime: true })]));
		expect(decision).toEqual({ redeem: false, reason: "no-reset-time" });
	});

	it("skips when no credit is available", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, 0)]));
		expect(decision).toEqual({ redeem: false, reason: "reserve" });
	});

	it("skips when resetCredits is undefined (cannot verify availability)", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, undefined)]));
		expect(decision).toEqual({ redeem: false, reason: "credits-unknown" });
	});

	it("respects the reserve: 1 credit with keepCredits 1 is held back", () => {
		const decision = evaluateCodexAutoRedeem(
			input([report(1.0, 3 * DAY, 1)], { settings: { autoRedeem: true, minBlockedMinutes: 60, keepCredits: 1 } }),
		);
		expect(decision).toEqual({ redeem: false, reason: "reserve" });
	});

	it("redeems above the reserve: 2 credits with keepCredits 1", () => {
		const decision = evaluateCodexAutoRedeem(
			input([report(1.0, 3 * DAY, 2)], { settings: { autoRedeem: true, minBlockedMinutes: 60, keepCredits: 1 } }),
		);
		expect(decision).toMatchObject({ redeem: true, availableCount: 2 });
	});

	it("skips when this block episode was already attempted", () => {
		const resetsAt = NOW + 3 * DAY;
		const blockKey = `${ACCOUNT_ID}|${Math.round(resetsAt / DEBOUNCE_BUCKET_MS)}`;
		const decision = evaluateCodexAutoRedeem(
			input([report(1.0, 3 * DAY, 1)], { attemptedBlockKeys: new Set([blockKey]) }),
		);
		expect(decision).toEqual({ redeem: false, reason: "already-attempted" });
	});

	it("treats +20s resetsAt jitter as the same block bucket", () => {
		const resetsAt = NOW + 3 * DAY;
		const blockKey = `${ACCOUNT_ID}|${Math.round(resetsAt / DEBOUNCE_BUCKET_MS)}`;
		// +20s stays within the same minute bucket -> same blockKey -> still already-attempted.
		const decision = evaluateCodexAutoRedeem(
			input([report(1.0, 3 * DAY + 20_000, 1)], { attemptedBlockKeys: new Set([blockKey]) }),
		);
		expect(decision).toEqual({ redeem: false, reason: "already-attempted" });
	});

	it("falls back to the per-account cooldown when jitter crosses the minute boundary", () => {
		const resetsAt = NOW + 3 * DAY;
		const seededBlockKey = `${ACCOUNT_ID}|${Math.round(resetsAt / DEBOUNCE_BUCKET_MS)}`;
		// +40s rounds into the next minute bucket -> different blockKey -> not already-attempted,
		// but lastAttempt 10s ago is inside the 60s cooldown.
		const decision = evaluateCodexAutoRedeem(
			input([report(1.0, 3 * DAY + 40_000, 1)], {
				attemptedBlockKeys: new Set([seededBlockKey]),
				lastAttemptAtByAccount: new Map([[ACCOUNT_ID, NOW - 10_000]]),
			}),
		);
		expect(decision).toEqual({ redeem: false, reason: "cooldown" });
	});

	it("skips Spark models (reset vs Spark meter is unknown)", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, 1)], { modelId: "gpt-5.3-codex-spark" }));
		expect(decision).toEqual({ redeem: false, reason: "spark-model" });
	});

	it("skips a non-Codex provider", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, 1)], { provider: "anthropic" }));
		expect(decision).toEqual({ redeem: false, reason: "wrong-provider" });
	});

	it("skips when the policy is disabled", () => {
		const decision = evaluateCodexAutoRedeem(
			input([report(1.0, 3 * DAY, 1)], { settings: { autoRedeem: false, minBlockedMinutes: 60, keepCredits: 0 } }),
		);
		expect(decision).toEqual({ redeem: false, reason: "disabled" });
		// The public setting defaults to prompt-on-eligibility, not silent spend.
		expect(SETTINGS_SCHEMA["codexResets.autoRedeem"].default).toBe("unset");
		expect(shouldEvaluateCodexAutoRedeem("unset")).toBe(true);
		expect(shouldPromptCodexAutoRedeem("unset")).toBe(true);
		expect(shouldEvaluateCodexAutoRedeem("yes")).toBe(true);
		expect(shouldPromptCodexAutoRedeem("yes")).toBe(false);
		expect(shouldEvaluateCodexAutoRedeem("no")).toBe(false);
		expect(shouldPromptCodexAutoRedeem("no")).toBe(false);
	});

	it("migrates legacy boolean autoRedeem config to the tri-state policy", () => {
		expect(Settings.isolated().get("codexResets.autoRedeem")).toBe("unset");
		expect(Settings.isolated({ "codexResets.autoRedeem": true }).get("codexResets.autoRedeem")).toBe("yes");
		expect(Settings.isolated({ "codexResets.autoRedeem": false }).get("codexResets.autoRedeem")).toBe("no");
	});

	it("skips a stale usage report", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, 1, { fetchedAgoMs: 11 * 60_000 })]));
		expect(decision).toEqual({ redeem: false, reason: "stale-report" });
	});

	it("skips when the active identity is unknown", () => {
		const decision = evaluateCodexAutoRedeem(input([report(1.0, 3 * DAY, 1)], { identity: undefined }));
		expect(decision).toEqual({ redeem: false, reason: "no-identity" });
	});

	it("skips when no report matches the active account", () => {
		const other = report(1.0, 3 * DAY, 1, { accountId: "acct-other", email: "other@example.com" });
		const decision = evaluateCodexAutoRedeem(input([other]));
		expect(decision).toEqual({ redeem: false, reason: "no-report" });
	});

	it("skips when there is no report at all", () => {
		const decision = evaluateCodexAutoRedeem(input(null));
		expect(decision).toEqual({ redeem: false, reason: "no-report" });
	});
});
