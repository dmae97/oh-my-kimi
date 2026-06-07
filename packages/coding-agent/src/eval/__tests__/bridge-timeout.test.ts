import { describe, expect, it } from "bun:test";
import {
	EVAL_TIMEOUT_PAUSE_OP,
	EVAL_TIMEOUT_RESUME_OP,
	isEvalTimeoutControlEvent,
	withBridgeTimeoutPause,
} from "../bridge-timeout";
import type { JsStatusEvent } from "../js/shared/types";

describe("withBridgeTimeoutPause", () => {
	it("emits one pause before the operation and one resume after it settles", async () => {
		const events: JsStatusEvent[] = [];

		const value = await withBridgeTimeoutPause(
			event => events.push(event),
			async () => {
				await Bun.sleep(80);
				return "done";
			},
		);

		expect(value).toBe("done");
		expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);

		const settledCount = events.length;
		await Bun.sleep(40);
		expect(events.length).toBe(settledCount);
	});

	it("resumes timeout accounting even when the operation throws", async () => {
		const events: JsStatusEvent[] = [];

		await expect(
			withBridgeTimeoutPause(
				event => events.push(event),
				async () => {
					await Bun.sleep(20);
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");

		expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
	});

	it("runs the operation without emitting when no status sink is wired", async () => {
		let ran = 0;

		const value = await withBridgeTimeoutPause(undefined, async () => {
			ran++;
			await Bun.sleep(20);
			return 42;
		});

		expect(value).toBe(42);
		expect(ran).toBe(1);
	});

	it("identifies timeout-control events as non-renderable status", () => {
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_PAUSE_OP })).toBe(true);
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_RESUME_OP })).toBe(true);
		expect(isEvalTimeoutControlEvent({ op: "agent", id: "subagent-1" })).toBe(false);
	});
});
