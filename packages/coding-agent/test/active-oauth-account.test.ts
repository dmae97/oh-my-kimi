import { describe, expect, test } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import {
	limitMatchesActiveAccount,
	reportMatchesActiveAccount,
} from "../src/slash-commands/helpers/active-oauth-account";

function makeLimit(scope: Partial<UsageLimit["scope"]> = {}): UsageLimit {
	return {
		id: "limit-1",
		label: "Requests",
		scope: { provider: "anthropic", ...scope },
		amount: { usedFraction: 0.5, unit: "percent" },
	};
}

function makeReport(overrides: Partial<UsageReport> = {}): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [makeLimit()],
		...overrides,
	};
}

describe("limitMatchesActiveAccount", () => {
	test("matches accountId against report metadata (camel and snake case) and limit scope", () => {
		const identity = { accountId: "ACC-1" };
		expect(limitMatchesActiveAccount(makeReport({ metadata: { accountId: "acc-1" } }), makeLimit(), identity)).toBe(
			true,
		);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { account_id: "acc-1" } }), makeLimit(), identity)).toBe(
			true,
		);
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ accountId: "acc-1" }), identity)).toBe(true);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { accountId: "acc-2" } }), makeLimit(), identity)).toBe(
			false,
		);
	});

	test("matches email against report metadata only — never against scope accountId", () => {
		const identity = { email: "user@example.com" };
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { email: "User@Example.com" } }), makeLimit(), identity),
		).toBe(true);
		// An email must not match an opaque account-id slot that happens to hold the same string.
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ accountId: "user@example.com" }), identity)).toBe(
			false,
		);
	});

	test("matches projectId for Google-style providers via scope or metadata", () => {
		const identity = { projectId: "gcp-proj-1" };
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ projectId: "gcp-proj-1" }), identity)).toBe(true);
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { projectId: "gcp-proj-1" } }), makeLimit(), identity),
		).toBe(true);
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ projectId: "gcp-proj-2" }), identity)).toBe(false);
	});

	test("returns false without an identity or with an empty identity", () => {
		expect(limitMatchesActiveAccount(makeReport({ metadata: { email: "a@b.c" } }), makeLimit(), undefined)).toBe(
			false,
		);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { email: "a@b.c" } }), makeLimit(), {})).toBe(false);
	});
});

describe("reportMatchesActiveAccount", () => {
	test("matches when any limit column belongs to the identity", () => {
		const report = makeReport({
			limits: [makeLimit({ accountId: "other" }), makeLimit({ accountId: "acc-1" })],
		});
		expect(reportMatchesActiveAccount(report, { accountId: "acc-1" })).toBe(true);
		expect(reportMatchesActiveAccount(report, { accountId: "acc-3" })).toBe(false);
	});

	test("does not match a report with no limits", () => {
		const report = makeReport({ limits: [], metadata: { email: "user@example.com" } });
		expect(reportMatchesActiveAccount(report, { email: "user@example.com" })).toBe(false);
	});
});
