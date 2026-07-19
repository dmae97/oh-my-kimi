import { describe, expect, it } from "vitest";
import {
	type CompactionHysteresisState,
	createCompactionHysteresisConfig,
	createCompactionHysteresisState,
	stepCompactionHysteresis,
} from "../src/core/compaction/hysteresis.ts";

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

describe("createCompactionHysteresisConfig", () => {
	it("creates a frozen config with valid thresholds", () => {
		const config = createCompactionHysteresisConfig({
			rearmRatio: 0.2,
			triggerRatio: 0.6,
			emergencyRatio: 0.9,
		});
		expect(Object.isFrozen(config)).toBe(true);
		expect(config.rearmRatio).toBe(0.2);
		expect(config.triggerRatio).toBe(0.6);
		expect(config.emergencyRatio).toBe(0.9);
	});

	it("rejects non-object input", () => {
		expect(() => createCompactionHysteresisConfig(null as never)).toThrow(TypeError);
		expect(() => createCompactionHysteresisConfig(42 as never)).toThrow(TypeError);
	});

	it("rejects extra keys (P2)", () => {
		expect(() =>
			createCompactionHysteresisConfig({
				rearmRatio: 0.2,
				triggerRatio: 0.6,
				emergencyRatio: 0.9,
				extra: true,
			} as never),
		).toThrow(/unsupported keys/);
	});

	it("rejects non-finite ratios", () => {
		expect(() =>
			createCompactionHysteresisConfig({ rearmRatio: NaN, triggerRatio: 0.6, emergencyRatio: 0.9 }),
		).toThrow(TypeError);
		expect(() =>
			createCompactionHysteresisConfig({ rearmRatio: Infinity, triggerRatio: 0.6, emergencyRatio: 0.9 }),
		).toThrow(TypeError);
	});

	it("rejects out-of-range ratios", () => {
		expect(() =>
			createCompactionHysteresisConfig({ rearmRatio: -0.1, triggerRatio: 0.6, emergencyRatio: 0.9 }),
		).toThrow(TypeError);
		expect(() =>
			createCompactionHysteresisConfig({ rearmRatio: 0.2, triggerRatio: 1.1, emergencyRatio: 0.9 }),
		).toThrow(TypeError);
	});

	it("rejects misordered thresholds", () => {
		// rearmRatio must be < triggerRatio
		expect(() =>
			createCompactionHysteresisConfig({ rearmRatio: 0.6, triggerRatio: 0.2, emergencyRatio: 0.9 }),
		).toThrow(/satisfy/);
		// triggerRatio must be <= emergencyRatio
		expect(() =>
			createCompactionHysteresisConfig({ rearmRatio: 0.2, triggerRatio: 0.9, emergencyRatio: 0.6 }),
		).toThrow(/satisfy/);
	});

	it("accepts equality: triggerRatio == emergencyRatio", () => {
		const config = createCompactionHysteresisConfig({
			rearmRatio: 0.2,
			triggerRatio: 0.8,
			emergencyRatio: 0.8,
		});
		expect(config.triggerRatio).toBe(config.emergencyRatio);
	});
});

describe("createCompactionHysteresisConfig boundary", () => {
	it("rejects rearmRatio == triggerRatio (strict inequality required)", () => {
		expect(() =>
			createCompactionHysteresisConfig({ rearmRatio: 0.2, triggerRatio: 0.2, emergencyRatio: 0.9 }),
		).toThrow(/satisfy/);
	});

	it("accepts rearmRatio=0, triggerRatio=0.01, emergencyRatio=1", () => {
		const config = createCompactionHysteresisConfig({
			rearmRatio: 0,
			triggerRatio: 0.01,
			emergencyRatio: 1,
		});
		expect(config.rearmRatio).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// State tests
// ---------------------------------------------------------------------------

describe("createCompactionHysteresisState", () => {
	it("defaults to armed: true without input", () => {
		const state = createCompactionHysteresisState();
		expect(Object.isFrozen(state)).toBe(true);
		expect(state.armed).toBe(true);
	});

	it("accepts armed: false", () => {
		const state = createCompactionHysteresisState({ armed: false });
		expect(state.armed).toBe(false);
		expect(Object.isFrozen(state)).toBe(true);
	});

	it("accepts armed: true", () => {
		const state = createCompactionHysteresisState({ armed: true });
		expect(state.armed).toBe(true);
	});

	it("rejects extra keys in state (P2)", () => {
		expect(() => createCompactionHysteresisState({ armed: true, extra: 1 } as never)).toThrow(/unsupported keys/);
	});

	it("rejects non-boolean armed", () => {
		expect(() => createCompactionHysteresisState({ armed: "yes" } as never)).toThrow(/boolean/);
	});

	it("rejects null input", () => {
		expect(() => createCompactionHysteresisState(null as never)).toThrow(/object/);
	});
});

// ---------------------------------------------------------------------------
// Hysteresis transition tests
// ---------------------------------------------------------------------------

function config(overrides: Partial<{ rearmRatio: number; triggerRatio: number; emergencyRatio: number }> = {}) {
	return createCompactionHysteresisConfig({
		rearmRatio: 0.2,
		triggerRatio: 0.6,
		emergencyRatio: 0.9,
		...overrides,
	});
}

function armed(): CompactionHysteresisState {
	return createCompactionHysteresisState({ armed: true });
}
function disarmed(): CompactionHysteresisState {
	return createCompactionHysteresisState({ armed: false });
}

describe("stepCompactionHysteresis", () => {
	// ---- Emergency ----
	it("returns compact/emergency when ratio >= emergencyRatio", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.95,
		});
		expect(result.action).toBe("compact");
		expect(result.reason).toBe("emergency_threshold_reached");
	});

	it("emergency triggers regardless of armed state", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: disarmed(),
			ratio: 0.95,
		});
		expect(result.action).toBe("compact");
		expect(result.reason).toBe("emergency_threshold_reached");
	});

	it("emergency at exact emergencyRatio", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.9,
		});
		expect(result.action).toBe("compact");
		expect(result.reason).toBe("emergency_threshold_reached");
	});

	// ---- Normal trigger ----
	it("returns compact/trigger when armed and ratio >= triggerRatio (below emergency)", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.7,
		});
		expect(result.action).toBe("compact");
		expect(result.reason).toBe("trigger_threshold_reached");
	});

	it("returns wait/below_trigger when armed but below triggerRatio", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.5,
		});
		expect(result.action).toBe("wait");
		expect(result.reason).toBe("below_trigger_threshold");
	});

	// ---- Disarm on commit ----
	it("disarms after commit", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.1,
			outcome: "commit",
		});
		expect(result.action).toBe("wait");
		expect(result.reason).toBe("commit_disarmed");
		expect(result.nextState.armed).toBe(false);
	});

	it("disarmed state persists after non-commit outcomes", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: disarmed(),
			ratio: 0.5,
			outcome: "abort",
		});
		expect(result.action).toBe("wait");
		expect(result.reason).toBe("disarmed_until_rearm");
		expect(result.nextState.armed).toBe(false);
	});

	// ---- Rearm ----
	it("rearms when ratio drops to rearmRatio or below", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: disarmed(),
			ratio: 0.15,
		});
		expect(result.action).toBe("wait");
		expect(result.reason).toBe("rearmed_at_low_watermark");
		expect(result.nextState.armed).toBe(true);
	});

	it("rearms at exact rearmRatio", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: disarmed(),
			ratio: 0.2,
		});
		expect(result.reason).toBe("rearmed_at_low_watermark");
		expect(result.nextState.armed).toBe(true);
	});

	it("does not rearm after commit even if ratio is low", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: disarmed(),
			ratio: 0.1,
			outcome: "commit",
		});
		// Commit disarms; rearm is suppressed since committed is true
		expect(result.reason).toBe("commit_disarmed");
		expect(result.nextState.armed).toBe(false);
	});

	// ---- Non-commit outcomes ----
	it("abort outcome does not disarm", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.5,
			outcome: "abort",
		});
		expect(result.action).toBe("wait");
		expect(result.nextState.armed).toBe(true);
	});

	it("stale outcome persists armed state", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.5,
			outcome: "stale",
		});
		expect(result.nextState.armed).toBe(true);
	});

	it("defer outcome persists armed state", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.5,
			outcome: "defer",
		});
		expect(result.nextState.armed).toBe(true);
	});

	it("none (default) outcome persists state", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.5,
		});
		expect(result.nextState.armed).toBe(true);
	});

	// ---- Input validation ----
	it("rejects extra keys in input (P2)", () => {
		expect(() =>
			stepCompactionHysteresis({
				config: config(),
				state: armed(),
				ratio: 0.5,
				extra: true,
			} as never),
		).toThrow(/unsupported keys/);
	});

	it("rejects non-object input", () => {
		expect(() => stepCompactionHysteresis(null as never)).toThrow(/object/);
		expect(() => stepCompactionHysteresis(42 as never)).toThrow(/object/);
	});

	it("rejects config with extra keys via validation chain", () => {
		expect(() =>
			stepCompactionHysteresis({
				config: { rearmRatio: 0.2, triggerRatio: 0.6, emergencyRatio: 0.9, extra: 1 },
				state: armed(),
				ratio: 0.5,
			} as never),
		).toThrow(/unsupported keys/);
	});

	it("rejects state with extra keys (P2)", () => {
		expect(() =>
			stepCompactionHysteresis({
				config: config(),
				state: { armed: true, extra: 1 } as never,
				ratio: 0.5,
			}),
		).toThrow(/unsupported keys/);
	});

	it("rejects invalid outcome strings", () => {
		expect(() =>
			stepCompactionHysteresis({
				config: config(),
				state: armed(),
				ratio: 0.5,
				outcome: "unknown" as never,
			}),
		).toThrow(/outcome must be/);
	});

	it("rejects non-finite ratio", () => {
		expect(() => stepCompactionHysteresis({ config: config(), state: armed(), ratio: NaN })).toThrow(TypeError);
	});

	// ---- Deterministic sequence / property loop ----
	it("full cycle: arm → trigger → commit → disarm → rearm → trigger", () => {
		const cfg = config();
		let state = armed();

		// 1. High ratio triggers compaction
		const r1 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.7 });
		expect(r1.action).toBe("compact");
		expect(r1.reason).toBe("trigger_threshold_reached");
		state = r1.nextState;
		expect(state.armed).toBe(true);

		// 2. Commit disarms
		const r2 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.1, outcome: "commit" });
		expect(r2.action).toBe("wait");
		expect(r2.reason).toBe("commit_disarmed");
		state = r2.nextState;
		expect(state.armed).toBe(false);

		// 3. Below trigger while disarmed → no trigger
		const r3 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.7 });
		expect(r3.action).toBe("wait");
		expect(r3.reason).toBe("disarmed_until_rearm");
		state = r3.nextState;
		expect(state.armed).toBe(false);

		// 4. Ratio drops to rearm level → rearm
		const r4 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.1 });
		expect(r4.action).toBe("wait");
		expect(r4.reason).toBe("rearmed_at_low_watermark");
		state = r4.nextState;
		expect(state.armed).toBe(true);

		// 5. High ratio again → trigger
		const r5 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.8 });
		expect(r5.action).toBe("compact");
		expect(r5.reason).toBe("trigger_threshold_reached");
		state = r5.nextState;
		expect(state.armed).toBe(true);
	});

	it("emergency repeat: emergency triggers, ratio stays high, triggers again", () => {
		const cfg = config();
		let state = armed();

		const r1 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.95 });
		expect(r1.action).toBe("compact");
		expect(r1.reason).toBe("emergency_threshold_reached");
		state = r1.nextState;
		expect(state.armed).toBe(true); // emergency doesn't disarm

		const r2 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.95 });
		expect(r2.action).toBe("compact");
		expect(r2.reason).toBe("emergency_threshold_reached");
		state = r2.nextState;
		expect(state.armed).toBe(true);
	});

	it("abort does not disarm, ratio high → still triggers", () => {
		const cfg = config();
		let state = armed();

		const r1 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.7 });
		expect(r1.action).toBe("compact");
		state = r1.nextState;

		const r2 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.5, outcome: "abort" });
		expect(r2.action).toBe("wait");
		expect(r2.nextState.armed).toBe(true);
		state = r2.nextState;

		const r3 = stepCompactionHysteresis({ config: cfg, state, ratio: 0.7 });
		expect(r3.action).toBe("compact");
	});

	it("all results are frozen", () => {
		const result = stepCompactionHysteresis({
			config: config(),
			state: armed(),
			ratio: 0.5,
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.nextState)).toBe(true);
	});

	it("preserves armed=false through stale outcome", () => {
		const cfg = config();
		const state = disarmed();

		const r = stepCompactionHysteresis({ config: cfg, state, ratio: 0.5, outcome: "stale" });
		expect(r.nextState.armed).toBe(false);
	});
});
