import { describe, expect, it } from "vitest";
import { DeferredCommandQueue, type DeferredHarnessCommand } from "../../src/harness/deferred-commands.ts";

function command(name: string, run: DeferredHarnessCommand["run"]): DeferredHarnessCommand {
	return { name, run };
}

/** Await a settled promise so a test can observe ordering across microtasks. */
async function tick(): Promise<void> {
	await Promise.resolve();
}

describe("DeferredCommandQueue", () => {
	it("runs a command immediately when the harness is already idle", async () => {
		const order: string[] = [];
		const queue = new DeferredCommandQueue(() => true);

		const ref = queue.enqueue(command("first", () => void order.push("first")));
		await queue.drain();
		await ref.done;

		expect(order).toEqual(["first"]);
		expect((await ref.done).status).toBe("completed");
		expect(ref.status).toBe("completed");
	});

	it("holds commands until the harness reports idle", async () => {
		const order: string[] = [];
		let idle = false;
		const queue = new DeferredCommandQueue(() => idle);

		const ref = queue.enqueue(command("held", () => void order.push("held")));
		await queue.drain();
		await tick();

		expect(order).toEqual([]);
		expect(ref.status).toBe("queued");
		expect(queue.size).toBe(1);

		idle = true;
		await queue.drain();
		await ref.done;

		expect(order).toEqual(["held"]);
		expect(queue.size).toBe(0);
	});

	it("runs commands in registration order", async () => {
		const order: string[] = [];
		const queue = new DeferredCommandQueue(() => true);

		const refs = ["a", "b", "c"].map((name) =>
			queue.enqueue(
				command(name, async () => {
					await tick();
					order.push(name);
				}),
			),
		);
		await queue.drain();
		await Promise.all(refs.map((ref) => ref.done));

		expect(order).toEqual(["a", "b", "c"]);
	});

	it("stops draining when a command makes the harness busy again", async () => {
		const order: string[] = [];
		let idle = true;
		const queue = new DeferredCommandQueue(() => idle);
		queue.enqueue(
			command("starts-operation", () => {
				order.push("starts-operation");
				idle = false;
			}),
		);
		const second = queue.enqueue(command("second", () => void order.push("second")));

		await queue.drain();
		await tick();

		expect(order).toEqual(["starts-operation"]);
		expect(second.status).toBe("queued");

		idle = true;
		await queue.drain();
		await second.done;
		expect(order).toEqual(["starts-operation", "second"]);
	});

	it("captures a command failure in its outcome instead of rejecting done", async () => {
		const queue = new DeferredCommandQueue(() => true);
		const boom = new Error("command exploded");
		const ref = queue.enqueue(
			command("failing", () => {
				throw boom;
			}),
		);

		await queue.drain();
		const outcome = await ref.done;

		expect(outcome).toEqual({ status: "failed", error: boom });
		expect(ref.status).toBe("failed");
	});

	it("cancels a queued command so it never runs", async () => {
		const order: string[] = [];
		const queue = new DeferredCommandQueue(() => false);
		const ref = queue.enqueue(command("doomed", () => void order.push("doomed")));

		expect(ref.cancel()).toBe(true);
		expect(ref.status).toBe("cancelled");
		expect(queue.size).toBe(0);
		expect(await ref.done).toEqual({ status: "cancelled" });

		await queue.drain();
		expect(order).toEqual([]);
	});

	it("refuses to cancel a command that already ran", async () => {
		const queue = new DeferredCommandQueue(() => true);
		const ref = queue.enqueue(command("done", () => undefined));

		await queue.drain();
		await ref.done;

		expect(ref.cancel()).toBe(false);
		expect(ref.status).toBe("completed");
	});

	it("cannot cancel a command that already started", async () => {
		const queue = new DeferredCommandQueue(() => true);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ref = queue.enqueue(command("long-running", () => gate));

		const draining = queue.drain();
		await tick();

		expect(ref.status).toBe("running");
		expect(ref.cancel()).toBe(false);

		release();
		await draining;

		expect(await ref.done).toEqual({ status: "completed", value: undefined });
	});

	it("gives every command a distinct durable id", () => {
		const queue = new DeferredCommandQueue(() => false);
		const first = queue.enqueue(command("a", () => undefined));
		const second = queue.enqueue(command("b", () => undefined));

		expect(first.commandId).not.toBe(second.commandId);
		expect(first.commandId.length).toBeGreaterThan(0);
	});

	it("never runs two drains at once", async () => {
		const order: string[] = [];
		const queue = new DeferredCommandQueue(() => true);
		const ref = queue.enqueue(
			command("slow", async () => {
				await tick();
				order.push("slow");
			}),
		);

		// Enqueue already scheduled a drain; these two must not run the command again.
		await Promise.all([queue.drain(), queue.drain()]);
		await ref.done;

		expect(order).toEqual(["slow"]);
	});
});
