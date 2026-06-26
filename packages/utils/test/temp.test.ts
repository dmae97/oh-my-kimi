import { expect, mock, test } from "bun:test";

function forceWin32(): () => void {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32" });
	return () => {
		if (original) Object.defineProperty(process, "platform", original);
	};
}

test("removeSyncWithRetries outlasts a transient 1.5s Windows EBUSY lock", async () => {
	let elapsedMs = 0;
	let calls = 0;
	const originalSleepSync = Bun.sleepSync;
	const restorePlatform = forceWin32();

	mock.module("node:fs", () => ({
		rmSync() {
			calls++;
			if (elapsedMs < 1500) {
				const err = new Error("busy") as Error & { code: string };
				err.code = "EBUSY";
				throw err;
			}
		},
	}));
	mock.module("node:fs/promises", () => ({ rm: async () => undefined }));
	Bun.sleepSync = ((ms: number) => {
		elapsedMs += ms;
	}) as typeof Bun.sleepSync;

	try {
		// Dynamic import is required so the node:fs mock is installed before temp.ts binds it.
		const { removeSyncWithRetries } = await import("../src/temp?ebusy-window-test");
		removeSyncWithRetries("/tmp/pr3348");
		expect(calls).toBe(31);
		expect(elapsedMs).toBe(1500);
	} finally {
		Bun.sleepSync = originalSleepSync;
		restorePlatform();
		mock.restore();
	}
});
