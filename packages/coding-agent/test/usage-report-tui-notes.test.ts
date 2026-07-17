/**
 * Regression coverage for the TUI aggregate path in `command-controller.ts`.
 *
 * Three contracts that the CLI `formatUsageBreakdown` test cannot cover,
 * because the bug lives in the TUI cross-account grouping renderer
 * `renderUsageReports`:
 *
 *  1. Provider-wide `UsageReport.notes` render ONCE above the per-account
 *     sections, not once per account/window.
 *  2. Identical per-limit notes from multiple accounts that fall in the same
 *     `label|windowId` group are de-duplicated.
 *  3. Wide terminals preserve organization suffixes that distinguish accounts
 *     sharing an email address.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

function limit(label: string, windowId: string, durationMs: number, frac: number, notes?: string[]) {
	return {
		id: windowId,
		label,
		scope: { provider: "github-copilot", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 0.8 ? "warning" : "ok",
		...(notes ? { notes } : {}),
	} satisfies UsageReport["limits"][number];
}

function report(provider: string, email: string, limits: UsageReport["limits"], notes?: string[]) {
	return {
		provider,
		fetchedAt: Date.now(),
		limits,
		...(notes ? { notes } : {}),
		metadata: { email },
	} satisfies UsageReport;
}

describe("renderUsageReports (#3268 TUI aggregate)", () => {
	it("renders provider-wide UsageReport.notes exactly once for multiple accounts", () => {
		const disclaimer = "OMP-observed spend only; OpenCode usage outside OMP is not included.";
		const reports: UsageReport[] = [
			report(
				"opencode-go",
				"acct-a@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3)],
				[disclaimer],
			),
			report(
				"opencode-go",
				"acct-b@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.6)],
				[disclaimer],
			),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(disclaimer).length - 1;
		expect(occurrences).toBe(1);
	});

	it("deduplicates identical per-limit notes when accounts share one window group", () => {
		// Both accounts report the SAME label+windowId, so their limits land in
		// one aggregate group; both carry an identical per-limit note.
		const note = "Overage requests: 5";
		const reports: UsageReport[] = [
			report("github-copilot", "acct-a@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.8, [note])]),
			report("github-copilot", "acct-b@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.9, [note])]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(note).length - 1;
		// Deduped: appears once on the group note line. Pre-fix `flatMap(...).join`
		// would bullet-join it twice (one per account in the group).
		expect(occurrences).toBe(1);
	});

	it("preserves organization suffixes when wide account columns can fit them", () => {
		const now = Date.now();
		const accountLimit = () => ({
			...limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3),
			window: {
				id: "rolling-5h",
				label: "5 Hour limit",
				durationMs: 5 * HOUR,
				resetsAt: now + 2.5 * HOUR,
			},
		});
		const reports: UsageReport[] = [
			{
				...report("anthropic", "rae@example.com", [accountLimit()]),
				metadata: { email: "rae@example.com", orgId: "team-org", orgName: "Team Org" },
			},
			report("anthropic", "rae@example.com", [accountLimit()]),
		];

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, now, 160));

		expect(text).toContain("rae@example.com (Team Org)");
	});
});

describe("renderUsageReports session marker (#5691 org-qualified identity)", () => {
	it("suffixes the active org so same-email multi-org accounts are tellable apart", () => {
		const email = "dev@example.test";
		const reports: UsageReport[] = [
			report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email, orgId: "uuid-A", orgName: "Team Org" } : undefined,
			),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(`${email} (Team Org)`);
	});

	it("falls back to the bare base when the active identity carries no org", () => {
		const email = "solo@example.test";
		const reports: UsageReport[] = [
			report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email } : undefined,
			),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(email);
		expect(marker).not.toContain("(");
	});
});
