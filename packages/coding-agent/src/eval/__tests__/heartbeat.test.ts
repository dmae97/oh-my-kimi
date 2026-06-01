import { afterEach, describe, expect, it } from "bun:test";
import { EVAL_HEARTBEAT_OP, setBridgeHeartbeatIntervalMs, withBridgeHeartbeat } from "../heartbeat";
import type { JsStatusEvent } from "../js/shared/types";

describe("withBridgeHeartbeat", () => {
	afterEach(() => {
		setBridgeHeartbeatIntervalMs();
	});

	it("pumps heartbeat events on cadence while the operation is pending, then stops", async () => {
		setBridgeHeartbeatIntervalMs(20);
		const events: JsStatusEvent[] = [];

		const value = await withBridgeHeartbeat(
			event => events.push(event),
			async () => {
				await Bun.sleep(130);
				return "done";
			},
		);

		expect(value).toBe("done");
		// ~6 ticks fit in 130ms at a 20ms cadence; assert it ticked repeatedly
		// without pinning the exact count (scheduler jitter).
		expect(events.length).toBeGreaterThanOrEqual(3);
		expect(events.every(event => event.op === EVAL_HEARTBEAT_OP)).toBe(true);

		// The interval is cleared once the operation settles: no further ticks.
		const settledCount = events.length;
		await Bun.sleep(80);
		expect(events.length).toBe(settledCount);
	});

	it("runs the operation without emitting when no status sink is wired", async () => {
		setBridgeHeartbeatIntervalMs(5);
		let ran = 0;

		const value = await withBridgeHeartbeat(undefined, async () => {
			ran++;
			await Bun.sleep(40);
			return 42;
		});

		expect(value).toBe(42);
		expect(ran).toBe(1);
	});

	it("clears the heartbeat even when the operation throws", async () => {
		setBridgeHeartbeatIntervalMs(15);
		const events: JsStatusEvent[] = [];

		await expect(
			withBridgeHeartbeat(
				event => events.push(event),
				async () => {
					await Bun.sleep(60);
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");

		const afterThrow = events.length;
		await Bun.sleep(60);
		expect(events.length).toBe(afterThrow);
	});
});
