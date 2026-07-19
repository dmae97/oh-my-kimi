import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	applyContextCacheInvalidation,
	CONTEXT_CACHE_INVALIDATION_SAFE_ID_MAX_LENGTH,
	CONTEXT_CACHE_INVALIDATION_SCHEMA_VERSION,
	type ContextCacheInvalidationEvent,
	type ContextCacheInvalidationSnapshot,
	type ContextCacheInvalidationSnapshotInit,
	createContextCacheInvalidationSnapshot,
	forkContextCacheSnapshot,
	isContextCacheInvalidationSnapshot,
	mergeContextCacheSnapshots,
	serializeContextCacheSnapshot,
	validateContextCacheInvalidationSnapshot,
} from "../src/core/context-budget-v2-cache-invalidation.ts";

const MAX = Number.MAX_SAFE_INTEGER;

function baseInit(over: Partial<ContextCacheInvalidationSnapshotInit> = {}): ContextCacheInvalidationSnapshotInit {
	return {
		forkId: "fork-main",
		worktreeFingerprint: "deadbeef",
		activeModelId: "gpt-test",
		compactionModelId: "gpt-compact",
		...over,
	};
}

function base(over: Partial<ContextCacheInvalidationSnapshotInit> = {}): ContextCacheInvalidationSnapshot {
	return createContextCacheInvalidationSnapshot(baseInit(over));
}

const COUNTER_EVENTS: ReadonlyArray<
	| { readonly type: "transcriptRepair" }
	| { readonly type: "toolResultDisposition" }
	| { readonly type: "evidenceReceipt" }
	| { readonly type: "userSteering" }
	| { readonly type: "settings" }
> = [
	{ type: "transcriptRepair" },
	{ type: "toolResultDisposition" },
	{ type: "evidenceReceipt" },
	{ type: "userSteering" },
	{ type: "settings" },
];

const IDENTITY_EVENTS: ReadonlyArray<{
	readonly type: "worktreeFingerprint" | "activeModelId" | "compactionModelId";
	readonly value: string;
}> = [
	{ type: "worktreeFingerprint", value: "feedface" },
	{ type: "activeModelId", value: "claude-opus" },
	{ type: "compactionModelId", value: "claude-haiku" },
];

describe("context-cache invalidation snapshot construction", () => {
	it("creates a schema-v1 snapshot with defaulted epoch and counters", () => {
		const snapshot = base();
		expect(snapshot.schemaVersion).toBe(CONTEXT_CACHE_INVALIDATION_SCHEMA_VERSION);
		expect(snapshot.forkId).toBe("fork-main");
		expect(snapshot.globalEpoch).toBe(0);
		expect(snapshot.counters).toEqual({
			transcriptRepair: 0,
			toolResultDisposition: 0,
			evidenceReceipt: 0,
			userSteering: 0,
			settings: 0,
		});
		expect(snapshot.worktreeFingerprint).toBe("deadbeef");
	});

	it("honours explicit epoch and counter initial values", () => {
		const snapshot = base({
			globalEpoch: 7,
			transcriptRepair: 3,
			settings: 5,
		});
		expect(snapshot.globalEpoch).toBe(7);
		expect(snapshot.counters.transcriptRepair).toBe(3);
		expect(snapshot.counters.settings).toBe(5);
		expect(snapshot.counters.evidenceReceipt).toBe(0);
	});
});

describe("context-cache invalidation eight-event table", () => {
	for (const event of COUNTER_EVENTS) {
		it(`increments the ${event.type} counter and the global epoch`, () => {
			const before = base();
			const result = applyContextCacheInvalidation(before, event);
			expect(result.status).toBe("applied");
			expect(result.snapshot.globalEpoch).toBe(1);
			expect(result.snapshot.counters[event.type]).toBe(1);
			for (const other of COUNTER_EVENTS) {
				if (other.type !== event.type) {
					expect(result.snapshot.counters[other.type]).toBe(0);
				}
			}
			expect(result.snapshot.forkId).toBe(before.forkId);
			expect(result.snapshot.worktreeFingerprint).toBe(before.worktreeFingerprint);
			expect(result.snapshot.activeModelId).toBe(before.activeModelId);
			expect(result.snapshot.compactionModelId).toBe(before.compactionModelId);
		});
	}

	for (const event of IDENTITY_EVENTS) {
		it(`sets the ${event.type} identity and bumps the global epoch`, () => {
			const before = base();
			const result = applyContextCacheInvalidation(before, event);
			expect(result.status).toBe("applied");
			expect(result.snapshot.globalEpoch).toBe(1);
			expect(result.snapshot[event.type]).toBe(event.value);
			expect(result.snapshot.counters).toEqual(before.counters);
		});
	}
});

describe("context-cache invalidation no-op identity sets", () => {
	for (const event of IDENTITY_EVENTS) {
		it(`returns unchanged for a same-value ${event.type} set without an epoch bump`, () => {
			const before = base();
			const first = applyContextCacheInvalidation(before, event);
			expect(first.status).toBe("applied");
			const second = applyContextCacheInvalidation(first.snapshot, event);
			expect(second.status).toBe("unchanged");
			expect(second.snapshot.globalEpoch).toBe(first.snapshot.globalEpoch);
			expect(second.snapshot[event.type]).toBe(event.value);
			expect(serializeContextCacheSnapshot(second.snapshot)).toBe(serializeContextCacheSnapshot(first.snapshot));
		});
	}

	it("leaves counters untouched on a no-op identity set", () => {
		const before = base({ transcriptRepair: 4 });
		const result = applyContextCacheInvalidation(before, {
			type: "activeModelId",
			value: before.activeModelId,
		});
		expect(result.status).toBe("unchanged");
		expect(result.snapshot.counters.transcriptRepair).toBe(4);
	});
});

describe("context-cache invalidation overflow handling", () => {
	for (const event of COUNTER_EVENTS) {
		it(`returns overflow without wrapping when ${event.type} is saturated`, () => {
			const saturated = base({ [event.type]: MAX } as Partial<ContextCacheInvalidationSnapshotInit>);
			const result = applyContextCacheInvalidation(saturated, event);
			expect(result.status).toBe("overflow");
			expect(result.snapshot.counters[event.type]).toBe(MAX);
			expect(result.snapshot.globalEpoch).toBe(0);
		});
	}

	it("returns overflow when the global epoch is saturated for a counter event", () => {
		const saturated = base({ globalEpoch: MAX, settings: 0 });
		const result = applyContextCacheInvalidation(saturated, { type: "settings" });
		expect(result.status).toBe("overflow");
		expect(result.snapshot.globalEpoch).toBe(MAX);
		expect(result.snapshot.counters.settings).toBe(0);
	});

	it("returns overflow when the global epoch is saturated for an identity change", () => {
		const saturated = base({ globalEpoch: MAX });
		const result = applyContextCacheInvalidation(saturated, {
			type: "activeModelId",
			value: "claude-opus",
		});
		expect(result.status).toBe("overflow");
		expect(result.snapshot.globalEpoch).toBe(MAX);
		expect(result.snapshot.activeModelId).toBe("gpt-test");
	});

	it("still treats a same-value identity set as unchanged when the epoch is saturated", () => {
		const saturated = base({ globalEpoch: MAX });
		const result = applyContextCacheInvalidation(saturated, {
			type: "activeModelId",
			value: saturated.activeModelId,
		});
		expect(result.status).toBe("unchanged");
		expect(result.snapshot.globalEpoch).toBe(MAX);
	});

	it("rejects an unsafe identity value even on overflow paths", () => {
		const snapshot = base();
		expect(() => applyContextCacheInvalidation(snapshot, { type: "activeModelId", value: "bad value" })).toThrowError(
			/activeModelId/,
		);
	});
});

describe("context-cache invalidation fork", () => {
	it("keeps counters and identities, changes fork id, and resets the global epoch", () => {
		const step = applyContextCacheInvalidation(base(), { type: "settings" }).snapshot;
		const parent = applyContextCacheInvalidation(step, {
			type: "activeModelId",
			value: "claude-opus",
		}).snapshot;
		expect(parent.globalEpoch).toBe(2);
		const forked = forkContextCacheSnapshot(parent, "fork-child");
		expect(forked.forkId).toBe("fork-child");
		expect(forked.globalEpoch).toBe(0);
		expect(forked.counters).toEqual(parent.counters);
		expect(forked.counters.settings).toBe(1);
		expect(forked.activeModelId).toBe("claude-opus");
		expect(forked.worktreeFingerprint).toBe(parent.worktreeFingerprint);
		expect(forked.compactionModelId).toBe(parent.compactionModelId);
	});

	it("strictly rejects forking onto the same fork id", () => {
		const snapshot = base();
		expect(() => forkContextCacheSnapshot(snapshot, snapshot.forkId)).toThrowError(/forkId/);
	});

	it("validates the supplied fork id", () => {
		const snapshot = base();
		expect(() => forkContextCacheSnapshot(snapshot, "")).toThrowError(/forkId/);
		expect(() => forkContextCacheSnapshot(snapshot, "bad id")).toThrowError(/forkId/);
	});
});

describe("context-cache invalidation merge", () => {
	it("merges structurally equal snapshots as equal", () => {
		const a = base({ globalEpoch: 3, settings: 2 });
		const b = createContextCacheInvalidationSnapshot(baseInit({ globalEpoch: 3, settings: 2 }));
		const merged = mergeContextCacheSnapshots(a, b);
		expect(merged.status).toBe("equal");
		if (merged.status !== "equal") return;
		expect(serializeContextCacheSnapshot(merged.snapshot)).toBe(serializeContextCacheSnapshot(a));
	});

	it("chooses the componentwise-dominant snapshot in either argument order", () => {
		const ancestor = base();
		const first = applyContextCacheInvalidation(ancestor, { type: "settings" }).snapshot;
		const successor = applyContextCacheInvalidation(first, { type: "userSteering" }).snapshot;
		expect(mergeContextCacheSnapshots(ancestor, successor).status).toBe("dominant");
		const forward = mergeContextCacheSnapshots(ancestor, successor);
		const reverse = mergeContextCacheSnapshots(successor, ancestor);
		if (forward.status !== "dominant" || reverse.status !== "dominant") throw new Error("expected dominant");
		expect(serializeContextCacheSnapshot(forward.snapshot)).toBe(serializeContextCacheSnapshot(successor));
		expect(serializeContextCacheSnapshot(reverse.snapshot)).toBe(serializeContextCacheSnapshot(successor));
	});

	it("rejects concurrent incomparable snapshots as divergent", () => {
		const ancestor = base();
		const left = applyContextCacheInvalidation(ancestor, { type: "settings" }).snapshot;
		const right = applyContextCacheInvalidation(ancestor, { type: "userSteering" }).snapshot;
		const merged = mergeContextCacheSnapshots(left, right);
		expect(merged.status).toBe("divergent");
		if (merged.status !== "divergent") return;
		expect(serializeContextCacheSnapshot(merged.left)).toBe(serializeContextCacheSnapshot(left));
		expect(serializeContextCacheSnapshot(merged.right)).toBe(serializeContextCacheSnapshot(right));
	});

	it("rejects snapshots with differing identity values as divergent", () => {
		const ancestor = base();
		const left = applyContextCacheInvalidation(ancestor, { type: "settings" }).snapshot;
		const right = applyContextCacheInvalidation(ancestor, {
			type: "activeModelId",
			value: "claude-opus",
		}).snapshot;
		expect(mergeContextCacheSnapshots(left, right).status).toBe("divergent");
	});

	it("rejects different forks as divergent", () => {
		const a = base();
		const forked = forkContextCacheSnapshot(a, "fork-other");
		expect(mergeContextCacheSnapshots(a, forked).status).toBe("divergent");
	});

	it("never max-merges disjoint counter changes", () => {
		const ancestor = base({ transcriptRepair: 1 });
		const left = applyContextCacheInvalidation(ancestor, { type: "settings" }).snapshot;
		const right = createContextCacheInvalidationSnapshot(
			baseInit({ transcriptRepair: 1, userSteering: 1, globalEpoch: 1 }),
		);
		expect(mergeContextCacheSnapshots(left, right).status).toBe("divergent");
	});
});

describe("context-cache invalidation strict validation", () => {
	it("rejects extra top-level keys", () => {
		const valid = base();
		const withExtra = { ...valid, extra: 1 } as unknown as ContextCacheInvalidationSnapshot;
		expect(() => validateContextCacheInvalidationSnapshot(withExtra)).toThrowError(/unexpected keys/);
		expect(isContextCacheInvalidationSnapshot(withExtra)).toBe(false);
	});

	it("rejects missing keys", () => {
		const valid = base();
		const { forkId: _forkId, ...missing } = valid;
		void _forkId;
		expect(() =>
			validateContextCacheInvalidationSnapshot(missing as unknown as ContextCacheInvalidationSnapshot),
		).toThrowError(/unexpected keys/);
	});

	it("rejects extra counter keys", () => {
		const valid = base();
		const bad = {
			...valid,
			counters: { ...valid.counters, rogue: 1 },
		} as unknown as ContextCacheInvalidationSnapshot;
		expect(() => validateContextCacheInvalidationSnapshot(bad)).toThrowError(/unexpected keys/);
	});

	it("rejects the wrong schema version", () => {
		const valid = base();
		const bad = { ...valid, schemaVersion: "context-cache-invalidation-v0" };
		expect(() => validateContextCacheInvalidationSnapshot(bad)).toThrowError(/schemaVersion/);
	});

	it("rejects negative, fractional, and unsafe-integer counters", () => {
		expect(() => createContextCacheInvalidationSnapshot(baseInit({ transcriptRepair: -1 }))).toThrowError(
			/transcriptRepair/,
		);
		expect(() => createContextCacheInvalidationSnapshot(baseInit({ settings: 1.5 }))).toThrowError(/settings/);
		expect(() => createContextCacheInvalidationSnapshot(baseInit({ userSteering: MAX + 1 }))).toThrowError(
			/userSteering/,
		);
		expect(() => createContextCacheInvalidationSnapshot(baseInit({ evidenceReceipt: Number.NaN }))).toThrowError(
			/evidenceReceipt/,
		);
		expect(() =>
			createContextCacheInvalidationSnapshot(baseInit({ toolResultDisposition: Number.POSITIVE_INFINITY })),
		).toThrowError(/toolResultDisposition/);
	});

	it("rejects control-unsafe and credential-unsafe identifiers", () => {
		expect(() => createContextCacheInvalidationSnapshot(baseInit({ forkId: "bad\nid" }))).toThrowError(/forkId/);
		expect(() => createContextCacheInvalidationSnapshot(baseInit({ forkId: "bad id" }))).toThrowError(/forkId/);
		expect(() => createContextCacheInvalidationSnapshot(baseInit({ forkId: 'bad"id' }))).toThrowError(/forkId/);
		expect(() =>
			createContextCacheInvalidationSnapshot(
				baseInit({ activeModelId: "x".repeat(CONTEXT_CACHE_INVALIDATION_SAFE_ID_MAX_LENGTH + 1) }),
			),
		).toThrowError(/activeModelId/);
		expect(() => createContextCacheInvalidationSnapshot(baseInit({ forkId: "" }))).toThrowError(/forkId/);
	});

	it("accepts legitimate bounded identifiers", () => {
		const snapshot = createContextCacheInvalidationSnapshot(
			baseInit({
				forkId: "11111111-2222-3333-4444-555555555555",
				worktreeFingerprint: "0123456789abcdef".repeat(4),
				activeModelId: "gpt-5-mini:2026-01-01",
				compactionModelId: "gpt-5-nano",
			}),
		);
		expect(isContextCacheInvalidationSnapshot(snapshot)).toBe(true);
	});

	it("isContextCacheInvalidationSnapshot is true for valid and false for malformed input", () => {
		expect(isContextCacheInvalidationSnapshot(base())).toBe(true);
		expect(isContextCacheInvalidationSnapshot(null)).toBe(false);
		expect(isContextCacheInvalidationSnapshot({})).toBe(false);
		expect(isContextCacheInvalidationSnapshot([])).toBe(false);
	});
});

describe("context-cache invalidation canonical serialization", () => {
	it("is deterministic across calls and independent builds", () => {
		const a = base({ globalEpoch: 2, settings: 1 });
		const b = createContextCacheInvalidationSnapshot(baseInit({ globalEpoch: 2, settings: 1 }));
		expect(serializeContextCacheSnapshot(a)).toBe(serializeContextCacheSnapshot(b));
		expect(serializeContextCacheSnapshot(a)).toBe(serializeContextCacheSnapshot(a));
	});

	it("encodes the schema version and every field in a fixed order", () => {
		const serialized = serializeContextCacheSnapshot(base());
		expect(serialized.startsWith('{"schemaVersion":')).toBe(true);
		const parsed = JSON.parse(serialized) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual([
			"schemaVersion",
			"forkId",
			"globalEpoch",
			"counters",
			"worktreeFingerprint",
			"activeModelId",
			"compactionModelId",
		]);
		const counters = parsed.counters as Record<string, unknown>;
		expect(Object.keys(counters)).toEqual([
			"transcriptRepair",
			"toolResultDisposition",
			"evidenceReceipt",
			"userSteering",
			"settings",
		]);
	});

	it("changes for every distinct field change", () => {
		const baseline = serializeContextCacheSnapshot(base());
		const fields: ReadonlyArray<{
			label: string;
			init: Partial<ContextCacheInvalidationSnapshotInit>;
		}> = [
			{ label: "forkId", init: { forkId: "fork-other" } },
			{ label: "globalEpoch", init: { globalEpoch: 1 } },
			{ label: "transcriptRepair", init: { transcriptRepair: 1 } },
			{ label: "toolResultDisposition", init: { toolResultDisposition: 1 } },
			{ label: "evidenceReceipt", init: { evidenceReceipt: 1 } },
			{ label: "userSteering", init: { userSteering: 1 } },
			{ label: "settings", init: { settings: 1 } },
			{ label: "worktreeFingerprint", init: { worktreeFingerprint: "cafef00d" } },
			{ label: "activeModelId", init: { activeModelId: "claude-opus" } },
			{ label: "compactionModelId", init: { compactionModelId: "claude-haiku" } },
		];
		for (const { label, init } of fields) {
			const changed = serializeContextCacheSnapshot(base(init));
			expect(changed, `${label} should change serialization`).not.toBe(baseline);
		}
	});
});

describe("context-cache invalidation deep freeze", () => {
	it("returns deeply frozen snapshots from every public producer", () => {
		const created = base({ settings: 1 });
		expect(Object.isFrozen(created)).toBe(true);
		expect(Object.isFrozen(created.counters)).toBe(true);

		const applied = applyContextCacheInvalidation(created, { type: "settings" });
		expect(Object.isFrozen(applied.snapshot)).toBe(true);
		expect(Object.isFrozen(applied.snapshot.counters)).toBe(true);

		const forked = forkContextCacheSnapshot(created, "fork-x");
		expect(Object.isFrozen(forked)).toBe(true);
		expect(Object.isFrozen(forked.counters)).toBe(true);

		const equal = mergeContextCacheSnapshots(
			created,
			createContextCacheInvalidationSnapshot(baseInit({ settings: 1 })),
		);
		if (equal.status !== "equal") throw new Error("expected equal");
		expect(Object.isFrozen(equal.snapshot)).toBe(true);
		expect(Object.isFrozen(equal.snapshot.counters)).toBe(true);
	});

	it("produces outputs independent of caller-held references", () => {
		const created = base();
		const result = applyContextCacheInvalidation(created, { type: "settings" });
		expect(result.snapshot).not.toBe(created);
		expect(result.snapshot.counters).not.toBe(created.counters);
		// A second distinct application yields another independent snapshot.
		const again = applyContextCacheInvalidation(result.snapshot, { type: "settings" });
		expect(again.snapshot).not.toBe(result.snapshot);
		expect(again.snapshot.counters).not.toBe(result.snapshot.counters);
		expect(again.snapshot.counters.settings).toBe(2);
	});
});

describe("context-cache invalidation long deterministic sequence", () => {
	it("converges to the same snapshot for two identical event sequences", () => {
		const events: ContextCacheInvalidationEvent[] = [];
		const identities = ["feedface", "cafef00d", "beefbabe"];
		let identityIndex = 0;
		for (let i = 0; i < 60; i++) {
			switch (i % 8) {
				case 0:
					events.push({ type: "transcriptRepair" });
					break;
				case 1:
					events.push({ type: "toolResultDisposition" });
					break;
				case 2:
					events.push({ type: "evidenceReceipt" });
					break;
				case 3:
					events.push({ type: "userSteering" });
					break;
				case 4:
					events.push({ type: "settings" });
					break;
				case 5:
					events.push({ type: "worktreeFingerprint", value: identities[identityIndex++ % identities.length] });
					break;
				case 6:
					events.push({ type: "activeModelId", value: `model-${i}` });
					break;
				case 7:
					events.push({ type: "compactionModelId", value: `compactor-${i}` });
					break;
			}
		}

		const run = (): ContextCacheInvalidationSnapshot => {
			let snapshot = base();
			for (const event of events) {
				const result = applyContextCacheInvalidation(snapshot, event);
				snapshot = result.snapshot;
			}
			return snapshot;
		};

		const first = run();
		const second = run();
		expect(serializeContextCacheSnapshot(first)).toBe(serializeContextCacheSnapshot(second));
		// 60 events, no no-ops (every identity value differs), so epoch == 60.
		expect(first.globalEpoch).toBe(60);
		expect(first.counters.transcriptRepair).toBe(8);
		expect(first.counters.toolResultDisposition).toBe(8);
		expect(first.counters.evidenceReceipt).toBe(8);
		expect(first.counters.userSteering).toBe(8);
		expect(first.counters.settings).toBe(7);
		expect(first.activeModelId).toBe("model-54");
		expect(first.compactionModelId).toBe("compactor-55");
	});
});

describe("context-cache invalidation strict event validation", () => {
	it("rejects a forged event with an unknown type instead of returning undefined", () => {
		const snapshot = base();
		const forged = { type: "nope" } as unknown as ContextCacheInvalidationEvent;
		let returned = false;
		try {
			applyContextCacheInvalidation(snapshot, forged);
			returned = true;
		} catch (error) {
			expect(String(error)).toMatch(/event type/);
		}
		expect(returned).toBe(false);
	});

	it("rejects a non-object event", () => {
		const snapshot = base();
		expect(() =>
			applyContextCacheInvalidation(snapshot, null as unknown as ContextCacheInvalidationEvent),
		).toThrowError(/event/);
		expect(() =>
			applyContextCacheInvalidation(snapshot, "settings" as unknown as ContextCacheInvalidationEvent),
		).toThrowError(/event/);
		expect(() =>
			applyContextCacheInvalidation(snapshot, [] as unknown as ContextCacheInvalidationEvent),
		).toThrowError(/event/);
	});

	it("rejects an event missing the type key", () => {
		const snapshot = base();
		expect(() => applyContextCacheInvalidation(snapshot, {} as ContextCacheInvalidationEvent)).toThrowError(/type/);
	});

	it("rejects a counter event carrying extra keys", () => {
		const snapshot = base();
		const extra = { type: "settings", value: "x" } as unknown as ContextCacheInvalidationEvent;
		expect(() => applyContextCacheInvalidation(snapshot, extra)).toThrowError(/unexpected keys/);
	});

	it("rejects an identity event missing its value key", () => {
		const snapshot = base();
		const missingValue = { type: "activeModelId" } as unknown as ContextCacheInvalidationEvent;
		expect(() => applyContextCacheInvalidation(snapshot, missingValue)).toThrowError(/unexpected keys/);
	});

	it("rejects an event whose type discriminant is not a string", () => {
		const snapshot = base();
		const badType = { type: 5 } as unknown as ContextCacheInvalidationEvent;
		expect(() => applyContextCacheInvalidation(snapshot, badType)).toThrowError(/type/);
	});

	it("rejects an event defined with accessor properties", () => {
		const snapshot = base();
		const accessorEvent = {
			get type() {
				return "settings";
			},
		} as unknown as ContextCacheInvalidationEvent;
		expect(() => applyContextCacheInvalidation(snapshot, accessorEvent)).toThrowError(/accessors/);
	});

	it("still applies all eight legitimate event types after validation", () => {
		const snapshot = base();
		for (const event of [...COUNTER_EVENTS, ...IDENTITY_EVENTS]) {
			expect(applyContextCacheInvalidation(snapshot, event).status).toBe("applied");
		}
	});
});

describe("context-cache invalidation strict constructor init validation", () => {
	it("rejects null, arrays, and primitives as init", () => {
		expect(() =>
			createContextCacheInvalidationSnapshot(null as unknown as ContextCacheInvalidationSnapshotInit),
		).toThrowError(/plain object/);
		expect(() =>
			createContextCacheInvalidationSnapshot([] as unknown as ContextCacheInvalidationSnapshotInit),
		).toThrowError(/plain object/);
		expect(() =>
			createContextCacheInvalidationSnapshot("nope" as unknown as ContextCacheInvalidationSnapshotInit),
		).toThrowError(/plain object/);
	});

	it("rejects unknown keys in init", () => {
		const bad = { ...baseInit(), rogue: 1 } as ContextCacheInvalidationSnapshotInit;
		expect(() => createContextCacheInvalidationSnapshot(bad)).toThrowError(/unknown key/);
	});

	it("rejects init missing a required identity key", () => {
		const { forkId: _forkId, ...missing } = baseInit();
		void _forkId;
		expect(() =>
			createContextCacheInvalidationSnapshot(missing as ContextCacheInvalidationSnapshotInit),
		).toThrowError(/missing required key/);
	});

	it("rejects init defined with accessor properties", () => {
		const accessorInit = {
			get forkId() {
				return "fork-main";
			},
			worktreeFingerprint: "deadbeef",
			activeModelId: "gpt-test",
			compactionModelId: "gpt-compact",
		} as ContextCacheInvalidationSnapshotInit;
		expect(() => createContextCacheInvalidationSnapshot(accessorInit)).toThrowError(/accessors/);
	});
});

describe("context-cache invalidation result wrapper freeze", () => {
	it("freezes every apply result wrapper and its nested snapshot", () => {
		const snapshot = base({ settings: 1 });

		const applied = applyContextCacheInvalidation(snapshot, { type: "settings" });
		expect(applied.status).toBe("applied");
		expect(Object.isFrozen(applied)).toBe(true);
		expect(Object.isFrozen(applied.snapshot)).toBe(true);
		expect(Object.isFrozen(applied.snapshot.counters)).toBe(true);

		const unchanged = applyContextCacheInvalidation(applied.snapshot, {
			type: "activeModelId",
			value: applied.snapshot.activeModelId,
		});
		expect(unchanged.status).toBe("unchanged");
		expect(Object.isFrozen(unchanged)).toBe(true);
		expect(Object.isFrozen(unchanged.snapshot)).toBe(true);
		expect(Object.isFrozen(unchanged.snapshot.counters)).toBe(true);

		const overflow = applyContextCacheInvalidation(base({ globalEpoch: MAX }), { type: "settings" });
		expect(overflow.status).toBe("overflow");
		expect(Object.isFrozen(overflow)).toBe(true);
		expect(Object.isFrozen(overflow.snapshot)).toBe(true);
		expect(Object.isFrozen(overflow.snapshot.counters)).toBe(true);
	});

	it("freezes every merge result wrapper, including divergent branches", () => {
		const ancestor = base();
		const first = applyContextCacheInvalidation(ancestor, { type: "settings" }).snapshot;
		const successor = applyContextCacheInvalidation(first, { type: "userSteering" }).snapshot;

		const equal = mergeContextCacheSnapshots(
			createContextCacheInvalidationSnapshot(baseInit({ globalEpoch: 3, settings: 2 })),
			createContextCacheInvalidationSnapshot(baseInit({ globalEpoch: 3, settings: 2 })),
		);
		expect(equal.status).toBe("equal");
		if (equal.status !== "equal") throw new Error("expected equal");
		expect(Object.isFrozen(equal)).toBe(true);
		expect(Object.isFrozen(equal.snapshot)).toBe(true);
		expect(Object.isFrozen(equal.snapshot.counters)).toBe(true);

		const dominant = mergeContextCacheSnapshots(ancestor, successor);
		expect(dominant.status).toBe("dominant");
		if (dominant.status !== "dominant") throw new Error("expected dominant");
		expect(Object.isFrozen(dominant)).toBe(true);
		expect(Object.isFrozen(dominant.snapshot)).toBe(true);

		const left = applyContextCacheInvalidation(ancestor, { type: "settings" }).snapshot;
		const right = applyContextCacheInvalidation(ancestor, { type: "userSteering" }).snapshot;
		const divergent = mergeContextCacheSnapshots(left, right);
		expect(divergent.status).toBe("divergent");
		if (divergent.status !== "divergent") throw new Error("expected divergent");
		expect(Object.isFrozen(divergent)).toBe(true);
		expect(Object.isFrozen(divergent.left)).toBe(true);
		expect(Object.isFrozen(divergent.right)).toBe(true);
		expect(Object.isFrozen(divergent.left.counters)).toBe(true);
		expect(Object.isFrozen(divergent.right.counters)).toBe(true);
	});
});

describe("context-cache invalidation credential rejection", () => {
	const credentialSamples: ReadonlyArray<{ label: string; value: string }> = [
		{ label: "openai sk-", value: "sk-1234567890abcdef" },
		{ label: "github classic", value: "ghp_1234567890abcdef1234567890abcdef123456" },
		{ label: "github fine-grained", value: "github_pat_11ABCDEFG0123456789abcdefghij" },
		{ label: "slack", value: "xoxb-1234567890-abcdefghij" },
		{ label: "aws", value: "AKIA1234567890ABCDEF" },
		{ label: "jwt", value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4f" },
		{ label: "bearer", value: "Bearer" },
	];

	const idFields: ReadonlyArray<"forkId" | "worktreeFingerprint" | "activeModelId" | "compactionModelId"> = [
		"forkId",
		"worktreeFingerprint",
		"activeModelId",
		"compactionModelId",
	];

	for (const sample of credentialSamples) {
		it(`rejects a ${sample.label} credential placed in every id/fingerprint field`, () => {
			for (const field of idFields) {
				const init = baseInit();
				(init as unknown as Record<string, unknown>)[field] = sample.value;
				expect(() => createContextCacheInvalidationSnapshot(init)).toThrowError(/credential/);
			}
		});
	}

	it("rejects a credential supplied via an identity event value", () => {
		const snapshot = base();
		expect(() =>
			applyContextCacheInvalidation(snapshot, { type: "activeModelId", value: "sk-1234567890abcdef" }),
		).toThrowError(/credential/);
	});

	it("still rejects control-unsafe identifiers before the credential gate", () => {
		expect(() => createContextCacheInvalidationSnapshot(baseInit({ forkId: "bad value" }))).toThrowError(
			/unsafe characters/,
		);
	});

	it("does not reject legitimate identifiers", () => {
		expect(() =>
			createContextCacheInvalidationSnapshot(
				baseInit({ forkId: "fork-main", activeModelId: "gpt-5-mini:2026-01-01" }),
			),
		).not.toThrow();
	});
});

describe("context-cache invalidation static forbidden API scan", () => {
	it("source file uses no host runtime or non-pure primitives", () => {
		const sourcePath = new URL("../src/core/context-budget-v2-cache-invalidation.ts", import.meta.url);
		const source = readFileSync(sourcePath, "utf8");
		const forbidden = [
			"node:",
			"require(",
			"Buffer",
			"globalThis",
			"global.",
			"Date.now",
			"new Date",
			"Math.random",
			"setTimeout",
			"setInterval",
			"setImmediate",
			"fetch(",
			"XMLHttpRequest",
			"localStorage",
			"process",
			"crypto",
			"import.meta",
			"performance.now",
			"MessageChannel",
			"WebSocket",
		];
		const found = forbidden.filter((token) => source.includes(token));
		expect(found, `forbidden tokens present: ${found.join(", ")}`).toEqual([]);
	});
});
