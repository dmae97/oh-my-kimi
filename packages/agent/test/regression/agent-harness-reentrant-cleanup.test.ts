import { type AssistantMessage, fauxAssistantMessage, registerFauxProvider } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("AgentHarness re-entrant run cleanup (regression)", () => {
	// Regression history: handleAgentEvent used to flip phase to "idle" and emit
	// agent_end/settled while the old run was still unwinding, so a settled
	// listener could fire-and-forget prompt() past the busy check and the old
	// run's cleanup clobbered the new run's abort controller and run promise.
	// The operation lifecycle closes that class by construction: settled fires
	// inside the settling barrier, inline reentry is rejected with "busy", and
	// abort()/waitForIdle() act on the lease of exactly one current operation.
	it("rejects settled-listener reentry and keeps abort()/waitForIdle() exact for the next operation", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const secondRunStarted = deferred();
		let secondRunSignal: AbortSignal | undefined;
		registration.setResponses([
			() => fauxAssistantMessage("first"),
			async (_context, options) => {
				secondRunSignal = options?.signal;
				secondRunStarted.resolve();
				// Block mid-provider-call until the second run is aborted.
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve();
						return;
					}
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("second");
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const firstRunEvents: string[] = [];
		let reentry: Promise<AssistantMessage> | undefined;
		harness.subscribe((event) => {
			if (!reentry) firstRunEvents.push(event.type);
			if (event.type === "settled" && !reentry) {
				// The strict lifecycle must refuse this, not clobber the next run.
				reentry = harness.prompt("inline");
			}
		});

		await harness.prompt("first");

		if (!reentry) throw new Error("settled listener did not attempt reentry");
		await expect(reentry).rejects.toMatchObject({ code: "busy" });

		// The externally observable event order of the first run is preserved.
		const agentEndIndex = firstRunEvents.indexOf("agent_end");
		const settledIndex = firstRunEvents.indexOf("settled");
		expect(agentEndIndex).toBeGreaterThanOrEqual(0);
		expect(settledIndex).toBeGreaterThan(agentEndIndex);

		// Settlement has fully completed: a fresh prompt is accepted.
		const secondPrompt = harness.prompt("second");
		await secondRunStarted.promise;

		// The second operation now owns the harness.
		await expect(harness.prompt("third")).rejects.toMatchObject({ code: "busy" });

		// waitForIdle() must not resolve while the second run is in flight.
		let idleResolved = false;
		const idlePromise = harness.waitForIdle().then(() => {
			idleResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(idleResolved).toBe(false);

		// abort() targets the in-flight second operation, never a stale one.
		await harness.abort();
		expect(secondRunSignal?.aborted).toBe(true);
		await idlePromise;
		expect(idleResolved).toBe(true);

		const second = await secondPrompt;
		expect(second?.role).toBe("assistant");
		expect(second?.stopReason).toBe("aborted");

		// The harness is genuinely idle again: a fresh prompt is accepted.
		registration.setResponses([() => fauxAssistantMessage("fourth")]);
		await expect(harness.prompt("fourth")).resolves.toMatchObject({ role: "assistant" });
	});
});
