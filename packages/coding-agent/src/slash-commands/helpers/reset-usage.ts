/**
 * Shared helpers for the `/reset-usage` command (TUI selector + ACP) and
 * auto-redeem: turn usage reports into a per-account list of redeemable saved
 * rate-limit resets, and map a redeem outcome code to a human message.
 */
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { OAuthAccountIdentity, ResetCreditRedeemOutcome, ResetCreditTarget } from "../../session/auth-storage";

export const CODEX_PROVIDER_ID = "openai-codex";

/** One Codex account row for the reset-usage selector. */
export interface ResetUsageAccount {
	/** Display label (email, else account id). */
	label: string;
	/** Saved resets redeemable for this account right now. */
	availableCount: number;
	/** Identifies the account when redeeming. */
	target: ResetCreditTarget;
	/** Whether this is the session's active Codex account. */
	active: boolean;
}

/**
 * Build the per-account reset list from usage reports (Codex only). Sorted with
 * the active account first, then most-credits, then label.
 */
export function buildResetUsageAccounts(
	reports: UsageReport[] | null | undefined,
	active?: OAuthAccountIdentity,
): ResetUsageAccount[] {
	const accounts = (reports ?? [])
		.filter(report => report.provider === CODEX_PROVIDER_ID)
		.map(report => {
			const accountId = typeof report.metadata?.accountId === "string" ? report.metadata.accountId : undefined;
			const email = typeof report.metadata?.email === "string" ? report.metadata.email : undefined;
			const isActive =
				!!active &&
				((!!active.accountId && active.accountId === accountId) || (!!active.email && active.email === email));
			return {
				label: email ?? accountId ?? "account",
				availableCount: report.resetCredits?.availableCount ?? 0,
				target: { accountId, email } satisfies ResetCreditTarget,
				active: isActive,
			};
		});
	return accounts.sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		if (a.availableCount !== b.availableCount) return b.availableCount - a.availableCount;
		return a.label.localeCompare(b.label);
	});
}

/** Human-facing summary of a redeem outcome for status lines and ACP output. */
export function describeRedeemOutcome(outcome: ResetCreditRedeemOutcome, label: string): string {
	switch (outcome.code) {
		case "reset":
			return `Reset applied for ${label} — your rate-limit window has been refreshed.`;
		case "already_redeemed":
			return `${label}: that reset was already redeemed.`;
		case "no_credit":
			return `${label}: no saved resets available to spend.`;
		case "nothing_to_reset":
			return `${label}: nothing to reset right now — your limits aren't constrained, so no credit was spent.`;
		case "no_account":
			return `Could not find a stored Codex account matching "${label}".`;
		case "account_unavailable":
			return `${label}: could not authenticate this account — try /login.`;
		default:
			return `${label}: reset did not apply (${outcome.code}).`;
	}
}
