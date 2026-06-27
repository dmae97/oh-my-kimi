/**
 * Regression for #3681: the `time_spent` status segment used to display
 * `Date.now() - sessionStartTime`, i.e. wall-clock since session start, so a
 * session that sat idle for hours still reported hours of "time spent".
 *
 * Contract:
 * - The segment reads `SegmentContext.activeMs` only — wall-clock never
 *   leaks in.
 * - `StatusLineComponent` accumulates `agent_start`→`agent_end` windows;
 *   reentrant starts and unmatched ends never double-count.
 * - `resetActiveTime` resets both the accumulator and any in-flight
 *   window so `/clear` and fresh-session flows zero the meter.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createCtx(activeMs: number): SegmentContext {
	return {
		// The segment under test never touches `session`; stub it.
		session: {} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		loopMode: null,
		goalMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		activeMs,
		activeRepo: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

function makeSession(): ConstructorParameters<typeof StatusLineComponent>[0] {
	// The component reads the session for usage stats, model, etc. The
	// time-spent accounting path never touches it — stub with the minimum
	// surface the constructor needs to settle.
	return {
		state: { messages: [], model: undefined },
		messages: [],
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "time-spent test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

describe("time_spent segment", () => {
	it("renders active processing time and ignores wall-clock", () => {
		const rendered = renderSegment("time_spent", createCtx(10_000));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("10");
		expect(rendered.content).toContain("s");
	});

	it("hides under one second of activity so the segment does not flash 0s at session start", () => {
		expect(renderSegment("time_spent", createCtx(0)).visible).toBe(false);
		expect(renderSegment("time_spent", createCtx(999)).visible).toBe(false);
		expect(renderSegment("time_spent", createCtx(1000)).visible).toBe(true);
	});

	it("scales beyond seconds: formatDuration produces minute/hour suffixes", () => {
		const fiveMin = renderSegment("time_spent", createCtx(5 * 60_000));
		expect(fiveMin.content).toContain("5m");
		const twoHours = renderSegment("time_spent", createCtx(2 * 3_600_000));
		expect(twoHours.content).toContain("2h");
	});
});

describe("StatusLineComponent active-time accounting", () => {
	it("accumulates only across markActivityStart/markActivityEnd windows, not idle time", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 1_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Idle: nothing accrues even as wall-clock advances.
		now += 10_000;
		expect(c.getActiveMs()).toBe(0);

		// First turn: 3s.
		now += 10_000;
		c.markActivityStart();
		now += 3_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(3_000);

		// Long idle gap (5 minutes) — total stays at 3s.
		now += 300_000;
		expect(c.getActiveMs()).toBe(3_000);

		// Second turn: 2s. Total = 5s.
		c.markActivityStart();
		now += 2_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(5_000);
	});

	it("ticks live during an open window so the segment animates while the agent runs", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 2_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 1_500;
		expect(c.getActiveMs()).toBe(1_500);
		now += 2_700;
		expect(c.getActiveMs()).toBe(4_200);
	});

	it("is idempotent: reentrant markActivityStart and unmatched markActivityEnd never double-count", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 3_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Unmatched end while idle is a no-op.
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);

		c.markActivityStart();
		// A second start while already running must not reset the anchor.
		now += 5_000;
		c.markActivityStart();
		now += 2_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(7_000);

		// Closing again is a no-op.
		now += 92_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(7_000);
	});

	it("resetActiveTime resets the active accumulator for /clear and fresh-session flows", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 4_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 10_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(10_000);

		c.resetActiveTime();
		expect(c.getActiveMs()).toBe(0);

		// Starting after reset begins from zero, not the prior total.
		now += 2_000;
		c.markActivityStart();
		now += 1_500;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(1_500);
	});

	it("resetActiveTime also drops an in-flight window so /clear during a turn starts fresh", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 5_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 4_000;
		expect(c.getActiveMs()).toBe(4_000);

		c.resetActiveTime();
		expect(c.getActiveMs()).toBe(0);

		// A stale markActivityEnd after the reset must not re-credit the dropped window.
		now += 5_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);
	});
});
