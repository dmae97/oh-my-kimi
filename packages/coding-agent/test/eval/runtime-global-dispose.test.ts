import { describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";

const GLOBAL_KEYS = ["__omp_import__", "read"] as const;

type GlobalKey = (typeof GLOBAL_KEYS)[number];

interface GlobalSnapshot {
	exists: boolean;
	value: unknown;
}

function snapshotGlobals(): Record<GlobalKey, GlobalSnapshot> {
	const globals = globalThis as Record<string, unknown>;
	return {
		__omp_import__: { exists: "__omp_import__" in globals, value: globals.__omp_import__ },
		read: { exists: "read" in globals, value: globals.read },
	};
}

function restoreGlobals(snapshot: Record<GlobalKey, GlobalSnapshot>): void {
	const globals = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		const state = snapshot[key];
		if (state.exists) globals[key] = state.value;
		else delete globals[key];
	}
}

function expectGlobalsRestored(snapshot: Record<GlobalKey, GlobalSnapshot>): void {
	const globals = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		const state = snapshot[key];
		if (state.exists) expect(globals[key]).toBe(state.value);
		else expect(key in globals).toBe(false);
	}
}

const hooks: RuntimeHooks = {
	onText: () => {},
	onDisplay: () => {},
	callTool: async () => undefined,
};

describe("JsRuntime global disposal", () => {
	it("keeps newer same-realm runtime globals after disposing an older runtime", () => {
		const globals = globalThis as Record<string, unknown>;
		const before = snapshotGlobals();
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "first" });
		const firstImport = globals.__omp_import__;
		const firstRead = globals.read;
		const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "second" });
		const secondImport = globals.__omp_import__;

		try {
			expect(typeof firstImport).toBe("function");
			expect(typeof firstRead).toBe("function");
			expect(secondImport).not.toBe(firstImport);
			expect(typeof globals.read).toBe("function");

			first.dispose();

			expect(globals.__omp_import__).toBe(secondImport);
			expect(globals.__omp_helpers__).toBe(second.helpers);
			expect(typeof globals.read).toBe("function");

			second.dispose();
			expectGlobalsRestored(before);
		} finally {
			first.dispose();
			second.dispose();
			restoreGlobals(before);
		}
	});

	it("reactivates older same-realm runtime globals when no other run is active", async () => {
		const globals = globalThis as Record<string, unknown>;
		const before = snapshotGlobals();
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "first-reactivated" });
		const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "second-reactivated" });

		try {
			expect(globals.__omp_helpers__).toBe(second.helpers);
			first.setCwd(process.cwd());
			expect(globals.__omp_helpers__).toBe(first.helpers);
			first.setRunScope({ reactivatedProbe: 7 });
			expect(globals.reactivatedProbe).toBe(7);
			expect(await first.run("1 + 6;", undefined, hooks)).toBe(7);
			second.setCwd(process.cwd());
			expect(globals.__omp_helpers__).toBe(second.helpers);
		} finally {
			delete globals.reactivatedProbe;
			first.dispose();
			second.dispose();
			restoreGlobals(before);
		}
	});

	it("rejects cross-runtime mutations while another same-realm runtime is running", async () => {
		const before = snapshotGlobals();
		const globals = globalThis as Record<string, unknown>;
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "first-overlap" });
		const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "second-overlap" });
		const gate = Promise.withResolvers<void>();
		let activeSecond: Promise<unknown> | undefined;

		try {
			second.setRunScope({ gate: gate.promise });
			activeSecond = second.run("await gate;", undefined, hooks);
			expect(() => first.setCwd(process.cwd())).toThrow("another same-realm JS runtime is running");
			await first.run("1", undefined, hooks).then(
				() => {
					throw new Error("expected active runtime rejection");
				},
				error =>
					expect(error).toHaveProperty(
						"message",
						"Cannot run code while another same-realm JS runtime is running",
					),
			);
			gate.resolve();
			await activeSecond;
			first.setCwd(process.cwd());
			expect(globals.__omp_helpers__).toBe(first.helpers);
		} finally {
			gate.resolve();
			if (activeSecond) await activeSecond.catch(() => undefined);
			delete globals.gate;
			first.dispose();
			second.dispose();
			restoreGlobals(before);
		}
	});
});
