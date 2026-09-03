import { describe, expect, it } from "vitest";
import { AgentHarnessError } from "../../src/harness/errors.ts";
import { SubscriberFanout } from "../../src/harness/subscriber-fanout.ts";

type Event = { readonly type: string; readonly seq: number };

function fanout(): SubscriberFanout<Event> {
	return new SubscriberFanout<Event>();
}

/** Resolve with the rejection reason instead of throwing, so a test can inspect it. */
async function captureRejection(promise: Promise<void>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
}

/** Record delivery order and invocation counts for one subscriber. */
function recorder(label: string, seen: string[], counts: Map<string, number>, fail?: "sync" | "async") {
	return (event: Event) => {
		seen.push(`${label}:${event.seq}`);
		counts.set(label, (counts.get(label) ?? 0) + 1);
		if (fail === "sync") throw new Error(`${label} failed`);
		if (fail === "async") return Promise.reject(new Error(`${label} failed`));
		return undefined;
	};
}

describe("SubscriberFanout observational delivery", () => {
	it("delivers to every subscriber in registration order when none fail", async () => {
		const events = fanout();
		const seen: string[] = [];
		const counts = new Map<string, number>();
		events.subscribe(recorder("first", seen, counts));
		events.subscribe(recorder("second", seen, counts));

		await events.emit({ type: "settled", seq: 1 }, undefined);

		expect(seen).toEqual(["first:1", "second:1"]);
		expect([...counts]).toEqual([
			["first", 1],
			["second", 1],
		]);
	});

	it("still delivers to later subscribers when an earlier one throws synchronously", async () => {
		const events = fanout();
		const seen: string[] = [];
		const counts = new Map<string, number>();
		events.subscribe(recorder("broken", seen, counts, "sync"));
		events.subscribe(recorder("audit", seen, counts));
		events.subscribe(recorder("telemetry", seen, counts));

		await expect(events.emit({ type: "attempt_finished", seq: 7 }, undefined)).rejects.toThrow();

		expect(seen).toEqual(["broken:7", "audit:7", "telemetry:7"]);
		expect(counts.get("audit")).toBe(1);
		expect(counts.get("telemetry")).toBe(1);
	});

	it("still delivers to later subscribers when an earlier one rejects asynchronously", async () => {
		const events = fanout();
		const seen: string[] = [];
		const counts = new Map<string, number>();
		events.subscribe(recorder("broken", seen, counts, "async"));
		events.subscribe(recorder("audit", seen, counts));

		await expect(events.emit({ type: "settled", seq: 2 }, undefined)).rejects.toThrow();

		expect(seen).toEqual(["broken:2", "audit:2"]);
		expect(counts.get("audit")).toBe(1);
	});

	it("classifies a single subscriber failure as a hook error", async () => {
		const events = fanout();
		events.subscribe(recorder("broken", [], new Map(), "sync"));

		const error = await captureRejection(events.emit({ type: "settled", seq: 1 }, undefined));

		expect(error).toBeInstanceOf(AgentHarnessError);
		expect((error as AgentHarnessError).code).toBe("hook");
		expect((error as AgentHarnessError).message).toBe("broken failed");
	});

	it("aggregates every subscriber failure after the fanout completes", async () => {
		const events = fanout();
		const seen: string[] = [];
		events.subscribe(recorder("first", seen, new Map(), "sync"));
		events.subscribe(recorder("second", seen, new Map()));
		events.subscribe(recorder("third", seen, new Map(), "async"));

		const error = await captureRejection(events.emit({ type: "settled", seq: 3 }, undefined));

		expect(seen).toEqual(["first:3", "second:3", "third:3"]);
		expect(error).toBeInstanceOf(AgentHarnessError);
		const causes = ((error as AgentHarnessError).cause as AggregateError).errors;
		expect(causes.map((cause) => (cause as Error).message)).toEqual(["first failed", "third failed"]);
	});

	it("keeps a pre-classified subscriber error's own code", async () => {
		const events = fanout();
		events.subscribe(() => {
			throw new AgentHarnessError("invalid_state", "Cannot abort during compaction");
		});
		events.subscribe(() => undefined);

		const error = await captureRejection(events.emit({ type: "settled", seq: 1 }, undefined));

		expect((error as AgentHarnessError).code).toBe("invalid_state");
	});

	it("reports a self-waiting subscriber without starving the others", async () => {
		const events = fanout();
		const seen: string[] = [];
		const operationId = "op-1";
		events.subscribe(() => {
			// What `waitForIdle()` / `abort()` do from a listener's synchronous prologue.
			events.assertNotSelfWait("waitForIdle()", operationId);
		});
		events.subscribe(recorder("audit", seen, new Map()));

		const error = await captureRejection(events.emit({ type: "settled", seq: 5 }, operationId));

		expect(seen).toEqual(["audit:5"]);
		expect((error as AgentHarnessError).code).toBe("invalid_state");
	});
});
