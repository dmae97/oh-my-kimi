import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	buildRedactionMap,
	collectUnreportedAccounts,
	computeProviderWindowStats,
	formatUsageBreakdown,
	type UsageAccountIdentity,
} from "@oh-my-pi/pi-coding-agent/cli/usage-cli";

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * 24 * HOUR;

function makeLimit(opts: {
	id: string;
	usedFraction: number;
	durationMs?: number;
	windowId?: string;
	tier?: string;
	accountId?: string;
}): UsageReport["limits"][number] {
	return {
		id: opts.id,
		label: opts.id,
		scope: {
			provider: "anthropic",
			windowId: opts.windowId,
			tier: opts.tier,
			accountId: opts.accountId,
		},
		window:
			opts.durationMs !== undefined
				? { id: opts.windowId ?? opts.id, label: opts.windowId ?? opts.id, durationMs: opts.durationMs }
				: undefined,
		amount: { unit: "percent", usedFraction: opts.usedFraction },
	};
}

function makeReport(provider: string, email: string, limits: UsageReport["limits"]): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, metadata: { email } };
}

describe("buildRedactionMap", () => {
	it("masks everything past a two-char anchor when the anchor is unique", () => {
		const map = buildRedactionMap(["alpha@example.test", "bravo@example.test"]);
		expect(map.get("alpha@example.test")).toBe("an*");
		expect(map.get("bravo@example.test")).toBe("ha*");
	});

	it("reveals a minimal middle-out differentiator instead of growing the prefix", () => {
		const values = ["dum.my@example.org", "dum.my9@example.net", "dummy@example.net"];
		const map = buildRedactionMap(values);
		const masks = values.map(value => map.get(value)!);
		// Masks must be pairwise distinct so accounts stay tellable-apart.
		expect(new Set(masks).size).toBe(masks.length);
		for (const mask of masks) {
			// Never leak the local part the way prefix growth would ("can.boluk@*").
			expect(mask).not.toContain("boluk");
			// anchor + at most a two-char differentiator.
			expect(mask).toMatch(/^ca\*(.{1,2}\*)?$/);
		}
		// The "89" account is distinguished by a digit only it contains.
		expect(map.get("dum.my9@example.net")).toBe("ca*9*");
	});

	it("gives duplicate identities the same mask", () => {
		const map = buildRedactionMap(["user@example.test", "user@example.test"]);
		expect(map.size).toBe(1);
		expect(map.get("user@example.test")).toBe("me*");
	});
});

describe("computeProviderWindowStats", () => {
	it("buckets by window duration, binds each account to its worst meter, and ceils the need", () => {
		const reports = [
			makeReport("anthropic", "a@x", [
				makeLimit({ id: "5h", usedFraction: 0.9, durationMs: FIVE_HOURS, windowId: "5h" }),
				makeLimit({ id: "7d", usedFraction: 0.1, durationMs: SEVEN_DAYS, windowId: "7d" }),
				// Tiered meter on the same window: higher burn must bind.
				makeLimit({ id: "7d-opus", usedFraction: 0.4, durationMs: SEVEN_DAYS, windowId: "7d", tier: "opus" }),
			]),
			makeReport("anthropic", "b@x", [
				makeLimit({ id: "5h", usedFraction: 0.4, durationMs: FIVE_HOURS, windowId: "5h" }),
				makeLimit({ id: "7d", usedFraction: 0.2, durationMs: SEVEN_DAYS, windowId: "7d" }),
			]),
		];
		const stats = computeProviderWindowStats(reports);
		expect(stats).toHaveLength(2);
		const [fiveHour, sevenDay] = stats;
		// Sorted shortest window first.
		expect(fiveHour.window).toBe("5h");
		expect(fiveHour.accounts).toBe(2);
		expect(fiveHour.usedAccounts).toBeCloseTo(1.3);
		expect(fiveHour.needed).toBe(2);
		expect(sevenDay.window).toBe("7d");
		expect(sevenDay.usedAccounts).toBeCloseTo(0.6); // 0.4 (opus binds) + 0.2
		expect(sevenDay.needed).toBe(1);
	});

	it("ignores limits without a resolvable fraction", () => {
		const reports = [
			makeReport("anthropic", "a@x", [
				{
					id: "mystery",
					label: "mystery",
					scope: { provider: "anthropic" },
					amount: { unit: "unknown" },
				},
			]),
		];
		expect(computeProviderWindowStats(reports)).toHaveLength(0);
	});
});

describe("collectUnreportedAccounts", () => {
	const accounts: UsageAccountIdentity[] = [
		{ provider: "anthropic", type: "oauth", email: "seen@x.com" },
		{ provider: "anthropic", type: "oauth", email: "missing@x.com" },
		{ provider: "anthropic", type: "api_key" },
		{ provider: "cerebras", type: "api_key" },
	];
	const reports = [makeReport("anthropic", "seen@x.com", [])];

	it("flags providers without reports and identified accounts missing from reports", () => {
		const unreported = collectUnreportedAccounts(reports, accounts);
		expect(unreported).toEqual([
			{ provider: "anthropic", type: "oauth", email: "missing@x.com" },
			{ provider: "cerebras", type: "api_key" },
		]);
	});

	it("does not claim unattributable credentials are missing when reports carry no identity", () => {
		const anonymous = [{ ...makeReport("anthropic", "seen@x.com", []), metadata: {} }];
		const unreported = collectUnreportedAccounts(anonymous, accounts);
		expect(unreported).toEqual([{ provider: "cerebras", type: "api_key" }]);
	});
});

describe("formatUsageBreakdown", () => {
	const reports = [
		makeReport("anthropic", "dum.my9@example.net", [
			makeLimit({ id: "Claude 5 Hour", usedFraction: 0.84, durationMs: FIVE_HOURS, windowId: "5h" }),
		]),
		makeReport("anthropic", "dummy@example.net", [
			makeLimit({ id: "Claude 5 Hour", usedFraction: 0.5, durationMs: FIVE_HOURS, windowId: "5h" }),
		]),
	];
	const accounts: UsageAccountIdentity[] = [
		{ provider: "anthropic", type: "oauth", email: "dum.my9@example.net" },
		{ provider: "anthropic", type: "oauth", email: "dummy@example.net" },
		{ provider: "cerebras", type: "api_key" },
	];

	it("renders every account: reported ones with limits, credential-only ones as no-data rows", () => {
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, accounts, Date.now()));
		expect(text).toContain("dum.my9@example.net");
		expect(text).toContain("84.0% used");
		expect(text).toContain("Cerebras");
		expect(text).toContain("API key — no usage data");
		expect(text).toContain("need: 5h → 2 of 2 accounts");
	});

	it("redacts account labels through the provided map without leaking the originals", () => {
		const redaction = buildRedactionMap(["dum.my9@example.net", "dummy@example.net"]);
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, accounts, Date.now(), redaction));
		expect(text).not.toContain("dum.my9@example.net");
		expect(text).not.toContain("dummy@example.net");
		for (const mask of redaction.values()) expect(text).toContain(mask);
	});
});
