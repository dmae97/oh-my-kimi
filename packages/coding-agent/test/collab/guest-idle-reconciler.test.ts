/**
 * Regression: a guest that received `agent_start` over the wire but missed
 * the matching `agent_end` across a reconnect must close its UI state when
 * the next host `state` frame reports the session idle. Without this, the
 * per-session `time_spent` meter (`#activeStartedAt`) and the `Working…`
 * loader linger after the host has yielded, so `time_spent` ticks forever
 * and the spinner never stops.
 *
 * The `state`-frame reconciler runs inside `CollabGuestLink.#applyFrame`,
 * which is private — exercising it through the full host/relay/welcome
 * train is heavyweight. The host-idle close logic is therefore extracted
 * as {@link reconcileGuestIdleHostState}; this test drives it directly.
 */
import { describe, expect, it, type Mock, mock } from "bun:test";
import { type GuestIdleReconcilerCtx, reconcileGuestIdleHostState } from "@oh-my-pi/pi-coding-agent/collab/guest";

interface Fixture {
	ctx: GuestIdleReconcilerCtx;
	markActivityEnd: Mock<() => void>;
	loaderStop: Mock<() => void>;
}

function makeCtx(hasLoader: boolean): Fixture {
	const markActivityEnd: Mock<() => void> = mock(() => {});
	const loaderStop: Mock<() => void> = mock(() => {});
	const ctx: GuestIdleReconcilerCtx = {
		statusLine: { markActivityEnd },
		loadingAnimation: hasLoader ? { stop: loaderStop } : undefined,
	};
	return { ctx, markActivityEnd, loaderStop };
}

describe("reconcileGuestIdleHostState", () => {
	it("closes the active-time window and stops the loader when the host reports idle", () => {
		const { ctx, markActivityEnd, loaderStop } = makeCtx(true);
		reconcileGuestIdleHostState(ctx, false);
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
		expect(loaderStop).toHaveBeenCalledTimes(1);
		// Loader is cleared so a second reconciliation does not re-stop it.
		expect(ctx.loadingAnimation).toBeUndefined();
	});

	it("is a no-op while the host is still streaming so live turns keep the meter open", () => {
		const { ctx, markActivityEnd, loaderStop } = makeCtx(true);
		reconcileGuestIdleHostState(ctx, true);
		expect(markActivityEnd).not.toHaveBeenCalled();
		expect(loaderStop).not.toHaveBeenCalled();
		expect(ctx.loadingAnimation).toBeDefined();
	});

	it("still closes the active window when no loader is present so the meter stops independently", () => {
		// The `time_spent` leak (#3681 review follow-up) does not require a
		// live loader: a state frame can arrive after the loader is already
		// stopped while the meter is still open.
		const { ctx, markActivityEnd } = makeCtx(false);
		reconcileGuestIdleHostState(ctx, false);
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
	});

	it("can run twice in a row without double-stopping the loader", () => {
		// markActivityEnd is idempotent on the StatusLineComponent side, but
		// the loader is cleared after the first close so a stale state frame
		// arriving later does not call `.stop()` on a disposed loader.
		const { ctx, loaderStop } = makeCtx(true);
		reconcileGuestIdleHostState(ctx, false);
		reconcileGuestIdleHostState(ctx, false);
		expect(loaderStop).toHaveBeenCalledTimes(1);
	});
});
