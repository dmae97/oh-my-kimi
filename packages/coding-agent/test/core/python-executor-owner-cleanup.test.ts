import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	disposeAllKernelSessions,
	disposeKernelSessionsByOwner,
	executePython,
	resetPreludeDocsCache,
	warmPythonEnvironment,
} from "@oh-my-pi/pi-coding-agent/ipy/executor";
import * as gatewayCoordinator from "@oh-my-pi/pi-coding-agent/ipy/gateway-coordinator";
import type {
	KernelExecuteResult,
	KernelShutdownResult,
	PreludeHelper,
	PythonKernel as PythonKernelInstance,
} from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { TempDir } from "@oh-my-pi/pi-utils";

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

type FakeKernelShutdownOptions = { timeoutMs?: number };

class FakeKernel {
	execute = vi.fn(async () => OK_RESULT);
	shutdown = vi.fn(
		async (_options?: FakeKernelShutdownOptions): Promise<KernelShutdownResult> => ({ confirmed: true }),
	);
	ping = vi.fn(async () => true);
	alive = true;

	isAlive(): boolean {
		return this.alive;
	}
}

async function flushMicrotasks(turns = 6): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) {
		await Promise.resolve();
	}
}

afterEach(async () => {
	await disposeAllKernelSessions();
	resetPreludeDocsCache();
	vi.restoreAllMocks();
});

describe("python executor owner cleanup", () => {
	it("keeps shared retained kernels alive until the last owner is disposed", async () => {
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("2 + 2", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(2);

		await disposeKernelSessionsByOwner("owner-a");

		expect(kernel.shutdown).not.toHaveBeenCalled();

		await executePython("3 + 3", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(3);

		await disposeKernelSessionsByOwner("owner-b");

		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("disposes every retained kernel owned by one owner across session ids and cwd values", async () => {
		const kernelOne = new FakeKernel();
		const kernelTwo = new FakeKernel();
		const unrelatedKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(kernelOne as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(kernelTwo as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(unrelatedKernel as unknown as PythonKernelInstance);

		await executePython("print('one')", {
			cwd: "/tmp/owner-a-one",
			sessionId: "session-one",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('two')", {
			cwd: "/tmp/owner-a-two",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('other')", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);

		await disposeKernelSessionsByOwner("owner-a");

		expect(kernelOne.shutdown).toHaveBeenCalledTimes(1);
		expect(kernelTwo.shutdown).toHaveBeenCalledTimes(1);
		expect(unrelatedKernel.shutdown).not.toHaveBeenCalled();

		await executePython("print('still alive')", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);
		expect(unrelatedKernel.execute).toHaveBeenCalledTimes(2);
	});

	it("falls back to the retained session id when no explicit owner id is provided during execution", async () => {
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/fallback-owner-session",
			sessionId: "fallback-session",
			kernelMode: "session",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("fallback-session");

		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not reattach a kernel after owner disposal has already claimed it", async () => {
		const disposingKernel = new FakeKernel();
		const replacementKernel = new FakeKernel();
		const shutdownDeferred = Promise.withResolvers<KernelShutdownResult>();
		disposingKernel.shutdown = vi.fn(() => shutdownDeferred.promise);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(disposingKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});

		const disposal = disposeKernelSessionsByOwner("owner-a");
		await executePython("2 + 2", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(disposingKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(disposingKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(replacementKernel.shutdown).not.toHaveBeenCalled();

		shutdownDeferred.resolve({ confirmed: true });
		await disposal;

		await disposeKernelSessionsByOwner("owner-b");
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("keeps tracked disposals counted against retained kernel capacity until shutdown settles", async () => {
		const retainedKernels = [new FakeKernel(), new FakeKernel(), new FakeKernel(), new FakeKernel()];
		const replacementKernel = new FakeKernel();
		const shutdownDeferreds = retainedKernels.map(() => Promise.withResolvers<KernelShutdownResult>());
		for (const [index, kernel] of retainedKernels.entries()) {
			kernel.shutdown = vi.fn(() => shutdownDeferreds[index]!.promise);
		}
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start");
		for (const kernel of [...retainedKernels, replacementKernel]) {
			startSpy.mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
		}

		for (const [index] of retainedKernels.entries()) {
			await executePython(`print(${index})`, {
				cwd: `/tmp/capacity-tracking-${index}`,
				sessionId: `capacity-session-${index}`,
				kernelMode: "session",
			});
		}
		expect(startSpy).toHaveBeenCalledTimes(4);

		const globalDisposal = disposeAllKernelSessions();
		await Promise.resolve();

		const fifthExecution = executePython("print('replacement')", {
			cwd: "/tmp/capacity-tracking-replacement",
			sessionId: "capacity-session-replacement",
			kernelMode: "session",
		});
		await Promise.resolve();

		expect(startSpy).toHaveBeenCalledTimes(4);
		expect(replacementKernel.execute).not.toHaveBeenCalled();

		shutdownDeferreds[0]!.resolve({ confirmed: true });
		await fifthExecution;
		expect(startSpy).toHaveBeenCalledTimes(5);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);

		for (const deferred of shutdownDeferreds.slice(1)) {
			deferred.resolve({ confirmed: true });
		}
		await globalDisposal;
		await disposeAllKernelSessions();
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("waits with the owner-cleanup timeout when the last owner is removed from an already-disposing session", async () => {
		vi.useFakeTimers();
		try {
			const kernel = new FakeKernel();
			const shutdownConfirmation = Promise.withResolvers<KernelShutdownResult>();
			kernel.shutdown = vi.fn(() => shutdownConfirmation.promise);
			vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
			const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

			await executePython("print('owner-a')", {
				cwd: "/tmp/disposing-owner-cleanup-session",
				sessionId: "disposing-owner-cleanup-session",
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});

			let globalCleanupResolved = false;
			const globalCleanup = disposeAllKernelSessions().finally(() => {
				globalCleanupResolved = true;
			});
			await flushMicrotasks();
			expect(kernel.shutdown).toHaveBeenCalledTimes(1);
			expect(globalCleanupResolved).toBe(false);

			let ownerCleanupResolved = false;
			const ownerCleanup = disposeKernelSessionsByOwner("owner-a").finally(() => {
				ownerCleanupResolved = true;
			});
			await flushMicrotasks();
			expect(ownerCleanupResolved).toBe(false);
			expect(kernel.shutdown).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(2_000);
			await ownerCleanup;
			expect(ownerCleanupResolved).toBe(true);
			expect(globalCleanupResolved).toBe(false);
			expect(kernel.shutdown).toHaveBeenCalledTimes(1);

			shutdownConfirmation.resolve({ confirmed: true });
			await globalCleanup;
			expect(globalCleanupResolved).toBe(true);
			expect(startSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns a cancelled result when a dead session restart shutdown times out", async () => {
		const kernel = new FakeKernel();
		kernel.alive = false;
		let shutdownCallCount = 0;
		kernel.shutdown = vi.fn(async (options?: FakeKernelShutdownOptions): Promise<KernelShutdownResult> => {
			shutdownCallCount += 1;
			if (shutdownCallCount > 1) {
				return { confirmed: true };
			}
			return await new Promise((_, reject) => {
				const timer = setTimeout(
					() => reject(new DOMException("Python kernel shutdown timed out", "TimeoutError")),
					options?.timeoutMs ?? 0,
				);
				timer.unref?.();
			});
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);

		const result = await executePython("1 + 1", {
			cwd: "/tmp/restart-timeout-session",
			sessionId: "restart-timeout-session",
			kernelMode: "session",
			timeoutMs: 100,
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(kernel.shutdown).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: expect.any(Number) }));
		expect(startSpy).toHaveBeenCalledTimes(1);
	});
	it("keeps local owner-cleanup disposals counted during resource-exhaustion recovery", async () => {
		vi.useFakeTimers();
		try {
			const staleKernels = [new FakeKernel(), new FakeKernel(), new FakeKernel()];
			const recoveredKernel = new FakeKernel();
			const laterKernel = new FakeKernel();
			const staleShutdownDeferreds = staleKernels.map(() => Promise.withResolvers<KernelShutdownResult>());
			for (const [index, kernel] of staleKernels.entries()) {
				kernel.shutdown = vi.fn(() => staleShutdownDeferreds[index]!.promise);
			}
			const shutdownSharedGatewaySpy = vi.spyOn(gatewayCoordinator, "shutdownSharedGateway").mockResolvedValue();
			vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
			const startSpy = vi.spyOn(PythonKernel, "start");
			for (const kernel of staleKernels) {
				startSpy.mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
			}
			startSpy
				.mockRejectedValueOnce(new Error("EMFILE: too many open files"))
				.mockResolvedValueOnce(recoveredKernel as unknown as PythonKernelInstance)
				.mockResolvedValueOnce(laterKernel as unknown as PythonKernelInstance);

			for (const [index] of staleKernels.entries()) {
				await executePython(`print(${index})`, {
					cwd: `/tmp/recovery-stale-${index}`,
					sessionId: `recovery-stale-session-${index}`,
					kernelMode: "session",
					kernelOwnerId: "owner-a",
				});
			}

			const ownerCleanup = disposeKernelSessionsByOwner("owner-a");
			await Promise.resolve();
			for (const kernel of staleKernels) {
				expect(kernel.shutdown).toHaveBeenCalledWith({ timeoutMs: 2_000 });
			}
			vi.advanceTimersByTime(2_000);
			await ownerCleanup;

			await executePython("print('recovered')", {
				cwd: "/tmp/recovery-after-emfile",
				sessionId: "recovery-session",
				kernelMode: "session",
			});
			expect(shutdownSharedGatewaySpy).toHaveBeenCalledTimes(1);
			expect(startSpy).toHaveBeenCalledTimes(5);
			expect(recoveredKernel.execute).toHaveBeenCalledTimes(1);

			const blockedExecution = executePython("print('later')", {
				cwd: "/tmp/recovery-after-emfile-later",
				sessionId: "recovery-session-later",
				kernelMode: "session",
			});
			await flushMicrotasks();
			expect(startSpy).toHaveBeenCalledTimes(5);
			expect(recoveredKernel.shutdown).not.toHaveBeenCalled();
			expect(laterKernel.execute).not.toHaveBeenCalled();

			staleShutdownDeferreds[0]!.resolve({ confirmed: true });
			await blockedExecution;
			expect(startSpy).toHaveBeenCalledTimes(6);
			expect(laterKernel.execute).toHaveBeenCalledTimes(1);

			for (const deferred of staleShutdownDeferreds.slice(1)) {
				deferred.resolve({ confirmed: true });
			}
			await flushMicrotasks();
			await disposeAllKernelSessions();
			expect(recoveredKernel.shutdown).toHaveBeenCalledTimes(1);
			expect(laterKernel.shutdown).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns owner cleanup promptly but keeps retained capacity reserved until shutdown is confirmed", async () => {
		vi.useFakeTimers();
		try {
			const retainedKernels = [new FakeKernel(), new FakeKernel(), new FakeKernel(), new FakeKernel()];
			const replacementKernel = new FakeKernel();
			const shutdownDeferreds = retainedKernels.map(() => Promise.withResolvers<KernelShutdownResult>());
			for (const [index, kernel] of retainedKernels.entries()) {
				kernel.shutdown = vi.fn(() => shutdownDeferreds[index]!.promise);
			}
			vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
			const startSpy = vi.spyOn(PythonKernel, "start");
			for (const kernel of [...retainedKernels, replacementKernel]) {
				startSpy.mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
			}

			for (const [index] of retainedKernels.entries()) {
				await executePython(`print(${index})`, {
					cwd: `/tmp/owner-timeout-kernel-${index}`,
					sessionId: `timeout-session-${index}`,
					kernelMode: "session",
					kernelOwnerId: "owner-a",
				});
			}

			let ownerCleanupResolved = false;
			const ownerCleanup = disposeKernelSessionsByOwner("owner-a").finally(() => {
				ownerCleanupResolved = true;
			});
			await flushMicrotasks();

			for (const kernel of retainedKernels) {
				expect(kernel.shutdown).toHaveBeenCalledWith({ timeoutMs: 2_000 });
			}
			expect(ownerCleanupResolved).toBe(false);

			vi.advanceTimersByTime(2_000);
			await ownerCleanup;
			expect(ownerCleanupResolved).toBe(true);

			const blockedExecution = executePython("print('replacement')", {
				cwd: "/tmp/owner-timeout-kernel-replacement",
				sessionId: "timeout-session-replacement",
				kernelMode: "session",
				kernelOwnerId: "owner-b",
			});
			await Promise.resolve();

			expect(startSpy).toHaveBeenCalledTimes(4);
			expect(replacementKernel.execute).not.toHaveBeenCalled();

			shutdownDeferreds[0]!.resolve({ confirmed: true });
			await blockedExecution;
			expect(startSpy).toHaveBeenCalledTimes(5);
			expect(replacementKernel.execute).toHaveBeenCalledTimes(1);

			for (const deferred of shutdownDeferreds.slice(1)) {
				deferred.resolve({ confirmed: true });
			}
			await Promise.resolve();
			await disposeAllKernelSessions();
			expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps owner-cleanup retries on the timer path without evicting unrelated live sessions", async () => {
		vi.useFakeTimers();
		try {
			const ownerKernel = new FakeKernel();
			const unrelatedKernels = [new FakeKernel(), new FakeKernel(), new FakeKernel()];
			const replacementKernel = new FakeKernel();
			const retryConfirmation = Promise.withResolvers<KernelShutdownResult>();
			let shutdownCallCount = 0;
			ownerKernel.shutdown = vi.fn(async (options?: FakeKernelShutdownOptions): Promise<KernelShutdownResult> => {
				shutdownCallCount += 1;
				if (shutdownCallCount === 1) {
					expect(options).toEqual({ timeoutMs: 2_000 });
					return { confirmed: false };
				}
				if (shutdownCallCount === 2) {
					expect(options).toBeUndefined();
					return { confirmed: false };
				}
				return await retryConfirmation.promise;
			});
			vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
			const startSpy = vi.spyOn(PythonKernel, "start");
			for (const kernel of [ownerKernel, ...unrelatedKernels, replacementKernel]) {
				startSpy.mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
			}

			await executePython("print('owner-a')", {
				cwd: "/tmp/timer-retry-owner-a",
				sessionId: "timer-retry-owner-a",
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});
			for (const [index, ownerId] of ["owner-b", "owner-c", "owner-d"].entries()) {
				await executePython(`print(${index})`, {
					cwd: `/tmp/timer-retry-${ownerId}`,
					sessionId: `timer-retry-${ownerId}`,
					kernelMode: "session",
					kernelOwnerId: ownerId,
				});
			}

			await disposeKernelSessionsByOwner("owner-a");
			expect(ownerKernel.shutdown).toHaveBeenCalledTimes(2);
			for (const kernel of unrelatedKernels) {
				expect(kernel.shutdown).not.toHaveBeenCalled();
			}

			const blockedExecution = executePython("print('replacement')", {
				cwd: "/tmp/timer-retry-replacement",
				sessionId: "timer-retry-replacement",
				kernelMode: "session",
				kernelOwnerId: "owner-e",
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(startSpy).toHaveBeenCalledTimes(4);
			expect(replacementKernel.execute).not.toHaveBeenCalled();
			for (const kernel of unrelatedKernels) {
				expect(kernel.shutdown).not.toHaveBeenCalled();
			}

			vi.advanceTimersByTime(29_999);
			await Promise.resolve();
			await Promise.resolve();
			expect(ownerKernel.shutdown).toHaveBeenCalledTimes(2);
			expect(startSpy).toHaveBeenCalledTimes(4);
			expect(replacementKernel.execute).not.toHaveBeenCalled();
			for (const kernel of unrelatedKernels) {
				expect(kernel.shutdown).not.toHaveBeenCalled();
			}

			vi.advanceTimersByTime(1);
			await Promise.resolve();
			await Promise.resolve();
			expect(ownerKernel.shutdown).toHaveBeenCalledTimes(3);
			expect(ownerKernel.shutdown).toHaveBeenNthCalledWith(3, undefined);
			expect(startSpy).toHaveBeenCalledTimes(4);
			expect(replacementKernel.execute).not.toHaveBeenCalled();
			for (const kernel of unrelatedKernels) {
				expect(kernel.shutdown).not.toHaveBeenCalled();
			}

			retryConfirmation.resolve({ confirmed: true });
			await blockedExecution;
			expect(startSpy).toHaveBeenCalledTimes(5);
			expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
			for (const kernel of unrelatedKernels) {
				expect(kernel.shutdown).not.toHaveBeenCalled();
			}

			await disposeAllKernelSessions();
			expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits for confirmed disposal capacity before evicting unrelated retained sessions", async () => {
		const ownerKernel = new FakeKernel();
		const unrelatedKernels = [new FakeKernel(), new FakeKernel(), new FakeKernel()];
		const replacementKernel = new FakeKernel();
		const retryConfirmation = Promise.withResolvers<KernelShutdownResult>();
		let shutdownCallCount = 0;
		ownerKernel.shutdown = vi.fn(async (_options?: FakeKernelShutdownOptions): Promise<KernelShutdownResult> => {
			shutdownCallCount += 1;
			if (shutdownCallCount === 1) {
				return { confirmed: false };
			}
			return await retryConfirmation.promise;
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start");
		for (const kernel of [ownerKernel, ...unrelatedKernels, replacementKernel]) {
			startSpy.mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
		}

		await executePython("print('owner-a')", {
			cwd: "/tmp/unconfirmed-owner-cleanup-a",
			sessionId: "unconfirmed-owner-cleanup-a",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		for (const [index, ownerId] of ["owner-b", "owner-c", "owner-d"].entries()) {
			await executePython(`print(${index})`, {
				cwd: `/tmp/unconfirmed-owner-cleanup-${ownerId}`,
				sessionId: `unconfirmed-owner-cleanup-${ownerId}`,
				kernelMode: "session",
				kernelOwnerId: ownerId,
			});
		}

		await disposeKernelSessionsByOwner("owner-a");
		expect(ownerKernel.shutdown).toHaveBeenCalledTimes(2);
		expect(ownerKernel.shutdown).toHaveBeenNthCalledWith(1, { timeoutMs: 2_000 });
		expect(ownerKernel.shutdown).toHaveBeenNthCalledWith(2, undefined);
		for (const kernel of unrelatedKernels) {
			expect(kernel.shutdown).not.toHaveBeenCalled();
		}

		const blockedExecution = executePython("print('replacement')", {
			cwd: "/tmp/unconfirmed-owner-cleanup-replacement",
			sessionId: "unconfirmed-owner-cleanup-replacement",
			kernelMode: "session",
			kernelOwnerId: "owner-e",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(startSpy).toHaveBeenCalledTimes(4);
		expect(replacementKernel.execute).not.toHaveBeenCalled();
		for (const [index, ownerId] of ["owner-b", "owner-c", "owner-d"].entries()) {
			await executePython(`print('reuse-${ownerId}')`, {
				cwd: `/tmp/unconfirmed-owner-cleanup-${ownerId}`,
				sessionId: `unconfirmed-owner-cleanup-${ownerId}`,
				kernelMode: "session",
				kernelOwnerId: ownerId,
			});
			expect(unrelatedKernels[index]!.execute).toHaveBeenCalledTimes(2);
			expect(unrelatedKernels[index]!.shutdown).not.toHaveBeenCalled();
		}
		expect(startSpy).toHaveBeenCalledTimes(4);
		expect(replacementKernel.execute).not.toHaveBeenCalled();

		retryConfirmation.resolve({ confirmed: true });
		await blockedExecution;
		expect(startSpy).toHaveBeenCalledTimes(5);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		for (const kernel of unrelatedKernels) {
			expect(kernel.shutdown).not.toHaveBeenCalled();
		}

		await disposeAllKernelSessions();
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("owner cleanup retries every shutdown in background and frees retained capacity one confirmation at a time", async () => {
		const retainedKernels = [new FakeKernel(), new FakeKernel(), new FakeKernel(), new FakeKernel()];
		const replacementKernel = new FakeKernel();
		const laterKernel = new FakeKernel();
		const retryConfirmations = retainedKernels.map(() => Promise.withResolvers<KernelShutdownResult>());
		for (const [index, kernel] of retainedKernels.entries()) {
			let shutdownCallCount = 0;
			kernel.shutdown = vi.fn(async (_options?: FakeKernelShutdownOptions): Promise<KernelShutdownResult> => {
				shutdownCallCount += 1;
				if (shutdownCallCount === 1) {
					return { confirmed: false };
				}
				return await retryConfirmations[index]!.promise;
			});
		}
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start");
		for (const kernel of [...retainedKernels, replacementKernel, laterKernel]) {
			startSpy.mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
		}

		for (const [index] of retainedKernels.entries()) {
			await executePython(`print(${index})`, {
				cwd: `/tmp/unconfirmed-capacity-${index}`,
				sessionId: `unconfirmed-capacity-session-${index}`,
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});
		}

		await disposeKernelSessionsByOwner("owner-a");
		for (const kernel of retainedKernels) {
			expect(kernel.shutdown).toHaveBeenCalledTimes(2);
			expect(kernel.shutdown).toHaveBeenNthCalledWith(1, { timeoutMs: 2_000 });
			expect(kernel.shutdown).toHaveBeenNthCalledWith(2, undefined);
		}

		let globalCleanupResolved = false;
		const globalCleanup = disposeAllKernelSessions().then(() => {
			globalCleanupResolved = true;
		});
		await Promise.resolve();
		await Promise.resolve();

		for (const kernel of retainedKernels) {
			expect(kernel.shutdown).toHaveBeenCalledTimes(2);
		}
		expect(globalCleanupResolved).toBe(false);

		const blockedExecution = executePython("print('replacement')", {
			cwd: "/tmp/unconfirmed-capacity-replacement",
			sessionId: "unconfirmed-capacity-replacement",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(startSpy).toHaveBeenCalledTimes(4);
		expect(replacementKernel.execute).not.toHaveBeenCalled();

		retryConfirmations[0]!.resolve({ confirmed: true });
		await blockedExecution;
		expect(globalCleanupResolved).toBe(false);
		expect(startSpy).toHaveBeenCalledTimes(5);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);

		const secondBlockedExecution = executePython("print('later')", {
			cwd: "/tmp/unconfirmed-capacity-later",
			sessionId: "unconfirmed-capacity-later",
			kernelMode: "session",
			kernelOwnerId: "owner-c",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(globalCleanupResolved).toBe(false);
		expect(startSpy).toHaveBeenCalledTimes(5);
		expect(laterKernel.execute).not.toHaveBeenCalled();

		retryConfirmations[1]!.resolve({ confirmed: true });
		await secondBlockedExecution;
		expect(globalCleanupResolved).toBe(false);
		expect(startSpy).toHaveBeenCalledTimes(6);
		expect(laterKernel.execute).toHaveBeenCalledTimes(1);

		for (const confirmation of retryConfirmations.slice(2)) {
			confirmation.resolve({ confirmed: true });
		}
		await globalCleanup;
		expect(globalCleanupResolved).toBe(true);

		await disposeAllKernelSessions();
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(laterKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not let stuck retained executions block owner or global cleanup", async () => {
		const ownerKernel = new FakeKernel();
		const globalKernel = new FakeKernel();
		const ownerExecutionStarted = Promise.withResolvers<void>();
		const globalExecutionStarted = Promise.withResolvers<void>();
		ownerKernel.execute = vi.fn(async () => {
			ownerExecutionStarted.resolve();
			return await new Promise<KernelExecuteResult>(() => {});
		});
		globalKernel.execute = vi.fn(async () => {
			globalExecutionStarted.resolve();
			return await new Promise<KernelExecuteResult>(() => {});
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(ownerKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(globalKernel as unknown as PythonKernelInstance);

		void executePython("print('owner hangs')", {
			cwd: "/tmp/stuck-owner-cleanup",
			sessionId: "stuck-owner-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await ownerExecutionStarted.promise;

		void executePython("print('global hangs')", {
			cwd: "/tmp/stuck-global-cleanup",
			sessionId: "stuck-global-session",
			kernelMode: "session",
		});
		await globalExecutionStarted.promise;

		const ownerCleanup = disposeKernelSessionsByOwner("owner-a");
		await flushMicrotasks();
		expect(ownerKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(globalKernel.shutdown).not.toHaveBeenCalled();
		await ownerCleanup;

		const globalCleanup = disposeAllKernelSessions();
		await flushMicrotasks();
		expect(globalKernel.shutdown).toHaveBeenCalledTimes(1);
		await globalCleanup;
	});

	it("attaches cached warmup sessions to newly provided owners", async () => {
		using tempDir = TempDir.createSync("@python-owner-warmup-");
		const docs: PreludeHelper[] = [
			{
				name: "read",
				signature: "(path)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const kernel = {
			introspectPrelude: vi.fn().mockResolvedValue(docs),
			execute: vi.fn(async () => OK_RESULT),
			ping: vi.fn(async () => true),
			isAlive: () => true,
			shutdown: vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: true })),
		};
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const firstWarmup = await warmPythonEnvironment(tempDir.path(), "warm-session", true, undefined, "owner-a");
		expect(firstWarmup.ok).toBe(true);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);

		const cachedWarmup = await warmPythonEnvironment(tempDir.path(), "warm-session", true, undefined, "owner-b");
		expect(cachedWarmup.ok).toBe(true);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);
		expect(startSpy).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-a");
		expect(kernel.shutdown).not.toHaveBeenCalled();

		await executePython("1 + 1", {
			cwd: tempDir.path(),
			sessionId: "warm-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-b");
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("keeps cache-hit ownerless warmups provisional until an explicit owner takes over", async () => {
		using tempDir = TempDir.createSync("@python-owner-fallback-");
		const docs: PreludeHelper[] = [
			{
				name: "read",
				signature: "(path)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const kernel = {
			introspectPrelude: vi.fn().mockResolvedValue(docs),
			execute: vi.fn(async () => OK_RESULT),
			ping: vi.fn(async () => true),
			isAlive: () => true,
			shutdown: vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: true })),
		};
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const firstWarmup = await warmPythonEnvironment(tempDir.path(), "warm-fallback-session", true);
		expect(firstWarmup.ok).toBe(true);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);

		const cachedWarmup = await warmPythonEnvironment(tempDir.path(), "warm-fallback-session", true);
		expect(cachedWarmup.ok).toBe(true);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);
		expect(startSpy).toHaveBeenCalledTimes(1);

		await executePython("1 + 1", {
			cwd: tempDir.path(),
			sessionId: "warm-fallback-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});

		expect(kernel.execute).toHaveBeenCalledTimes(1);

		const postTakeoverWarmup = await warmPythonEnvironment(tempDir.path(), "warm-fallback-session", true);
		expect(postTakeoverWarmup.ok).toBe(true);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);
		expect(startSpy).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-a");
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("warm-fallback-session");
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("leaves per-call kernels out of owner-scoped retained cleanup and keeps global cleanup intact", async () => {
		const perCallKernel = new FakeKernel();
		const retainedKernel = new FakeKernel();
		const unownedRetainedKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(perCallKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(retainedKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(unownedRetainedKernel as unknown as PythonKernelInstance);

		await executePython("print('per-call')", {
			cwd: "/tmp/per-call-owner",
			kernelMode: "per-call",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('retained')", {
			cwd: "/tmp/retained-owner",
			sessionId: "retained-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('unowned')", {
			cwd: "/tmp/unowned-retained",
			sessionId: "unowned-session",
			kernelMode: "session",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);
		expect(perCallKernel.shutdown).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-a");

		expect(perCallKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(retainedKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(unownedRetainedKernel.shutdown).not.toHaveBeenCalled();

		await disposeAllKernelSessions();

		expect(unownedRetainedKernel.shutdown).toHaveBeenCalledTimes(1);
	});
});
