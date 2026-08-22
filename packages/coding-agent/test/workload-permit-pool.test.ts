import { describe, expect, it } from "vitest";
import {
	WorkloadPermitError,
	WorkloadPermitPool,
	type WorkloadPermitRequest,
} from "../src/core/workload-permit-pool.ts";

function request(overrides: Partial<WorkloadPermitRequest> = {}): WorkloadPermitRequest {
	return {
		requestId: overrides.requestId ?? `req-${Math.random().toString(36).slice(2)}`,
		promptRunId: "run-1",
		workloadClass: "heavy",
		weight: 1,
		...overrides,
	};
}

async function settled<T>(promise: Promise<T>): Promise<"pending" | "resolved" | "rejected"> {
	const marker = Symbol("pending");
	const result = await Promise.race([
		promise.then(
			() => "resolved" as const,
			() => "rejected" as const,
		),
		Promise.resolve(marker),
	]);
	return result === marker ? "pending" : result;
}

describe("WorkloadPermitPool — §10.3 rules", () => {
	it("grants immediately within capacity and tracks weight", async () => {
		const pool = new WorkloadPermitPool({ capacity: 2 });
		const first = await pool.acquire(request());
		const second = await pool.acquire(request());
		expect(pool.snapshot()).toEqual({ capacity: 2, activeWeight: 2, queuedCount: 0 });
		first.release();
		second.release();
		expect(pool.snapshot().activeWeight).toBe(0);
	});

	it("queues FIFO and grants strictly in order (§10.4)", async () => {
		const pool = new WorkloadPermitPool({ capacity: 1 });
		const first = await pool.acquire(request({ requestId: "a" }));
		const order: string[] = [];
		const second = pool.acquire(request({ requestId: "b" })).then((permit) => {
			order.push("b");
			return permit;
		});
		const third = pool.acquire(request({ requestId: "c" })).then((permit) => {
			order.push("c");
			return permit;
		});
		expect(pool.snapshot().queuedCount).toBe(2);
		first.release();
		(await second).release();
		(await third).release();
		expect(order).toEqual(["b", "c"]);
		expect(pool.snapshot()).toEqual({ capacity: 1, activeWeight: 0, queuedCount: 0 });
	});

	it("supports weight-2 requests and blocks the head until weight fits", async () => {
		const pool = new WorkloadPermitPool({ capacity: 2 });
		const light = await pool.acquire(request());
		const heavy = pool.acquire(request({ weight: 2 }));
		expect(await settled(heavy)).toBe("pending");
		light.release();
		const permit = await heavy;
		expect(pool.snapshot().activeWeight).toBe(2);
		permit.release();
	});

	it("rejects a request wider than capacity immediately", async () => {
		const pool = new WorkloadPermitPool({ capacity: 1 });
		await expect(pool.acquire(request({ weight: 2 }))).rejects.toMatchObject({ code: "over_capacity_weight" });
	});

	it("rejects on queue overflow with a structured code (§15.4 queue_overflow)", async () => {
		const pool = new WorkloadPermitPool({ capacity: 1, maxQueue: 1 });
		const active = await pool.acquire(request());
		const queued = pool.acquire(request());
		await expect(pool.acquire(request())).rejects.toMatchObject({ code: "queue_overflow" });
		active.release();
		(await queued).release();
	});

	it("is abort-aware before and during the wait", async () => {
		const pool = new WorkloadPermitPool({ capacity: 1 });
		const aborted = new AbortController();
		aborted.abort();
		await expect(pool.acquire(request({ signal: aborted.signal }))).rejects.toMatchObject({ code: "aborted" });

		const active = await pool.acquire(request());
		const controller = new AbortController();
		const waiting = pool.acquire(request({ signal: controller.signal }));
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ code: "aborted" });
		expect(pool.snapshot().queuedCount).toBe(0);
		active.release();
		expect(pool.snapshot().activeWeight).toBe(0);
	});

	it("is timeout-aware", async () => {
		const pool = new WorkloadPermitPool({ capacity: 1 });
		const active = await pool.acquire(request());
		await expect(pool.acquire(request({ timeoutMs: 20 }))).rejects.toMatchObject({ code: "timeout" });
		active.release();
	});

	it("treats double release as a diagnosable no-op (§10.3 exactly-once)", async () => {
		const pool = new WorkloadPermitPool({ capacity: 2 });
		const permit = await pool.acquire(request());
		permit.release();
		permit.release();
		permit.release();
		expect(pool.snapshot().activeWeight).toBe(0);
		expect(pool.doubleReleaseCount).toBe(2);
	});

	it("never revokes in-flight permits when capacity shrinks, and rejects an unfittable head", async () => {
		const pool = new WorkloadPermitPool({ capacity: 2 });
		const wide = await pool.acquire(request({ weight: 2 }));
		const queuedWide = pool.acquire(request({ weight: 2 }));
		pool.setCapacity(1);
		// The queued weight-2 head can never fit under capacity 1: structured reject.
		await expect(queuedWide).rejects.toMatchObject({ code: "over_capacity_weight" });
		expect(pool.snapshot().capacity).toBe(1);
		expect(pool.snapshot().activeWeight).toBe(2); // in-flight permit untouched
		wide.release();
		expect(pool.snapshot().activeWeight).toBe(0);
	});

	it("property 7+8 (§23.2 seed 0x0fc52026): exactly-once release and no leaked weight under random interleavings", async () => {
		const random = mulberry32(0x0fc52026);
		for (let iteration = 0; iteration < 100; iteration++) {
			const capacity = 1 + Math.floor(random() * 3);
			const pool = new WorkloadPermitPool({ capacity, maxQueue: 64 });
			const outcomes: Array<Promise<void>> = [];
			for (let i = 0; i < 12; i++) {
				const controller = new AbortController();
				const weight: 1 | 2 = random() < 0.25 && capacity >= 2 ? 2 : 1;
				const timeoutMs = random() < 0.3 ? 1 + Math.floor(random() * 10) : undefined;
				const promise = pool
					.acquire(request({ weight, signal: controller.signal, timeoutMs }))
					.then(async (permit) => {
						if (random() < 0.5) {
							await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * 5)));
						}
						permit.release();
						if (random() < 0.3) {
							permit.release(); // double release must stay a no-op
						}
					})
					.catch((error: unknown) => {
						expect(error).toBeInstanceOf(WorkloadPermitError);
					});
				if (random() < 0.2) {
					controller.abort();
				}
				outcomes.push(promise);
			}
			await Promise.all(outcomes);
			const snapshot = pool.snapshot();
			expect(snapshot.activeWeight).toBe(0);
			expect(snapshot.queuedCount).toBe(0);
		}
	});
});

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
