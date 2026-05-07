import { describe, expect, test, vi } from "bun:test";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	parseLoopLimitArgs,
} from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import type { BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/loop slash command", () => {
	test("accepts an optional limit argument", async () => {
		const handleLoopCommand = vi.fn(async (_args?: string) => {});
		const runtime = {
			ctx: {
				handleLoopCommand,
				editor: { setText: vi.fn() },
			},
			handleBackgroundCommand: vi.fn(),
		} as unknown as BuiltinSlashCommandRuntime;
		const result = await executeBuiltinSlashCommand("/loop 10min", runtime);

		expect(result).toBe(true);
		expect(handleLoopCommand).toHaveBeenCalledWith("10min");
	});
});

describe("loop limit parsing", () => {
	test("parses a bare positive integer as an iteration limit", () => {
		expect(parseLoopLimitArgs("10")).toEqual({ kind: "iterations", iterations: 10 });
	});

	test("parses minute duration aliases", () => {
		expect(parseLoopLimitArgs("10m")).toEqual({ kind: "duration", durationMs: 600_000 });
		expect(parseLoopLimitArgs("10min")).toEqual({ kind: "duration", durationMs: 600_000 });
		expect(parseLoopLimitArgs("10 minutes")).toEqual({ kind: "duration", durationMs: 600_000 });
	});

	test("rejects zero, negative, and unknown limits", () => {
		expect(parseLoopLimitArgs("0")).toBe("Loop count must be a positive integer.");
		expect(parseLoopLimitArgs("-1")).toContain("Usage: /loop");
		expect(parseLoopLimitArgs("10fortnights")).toBe("Loop duration unit must be seconds, minutes, or hours.");
	});
});

describe("loop limit runtime", () => {
	test("allows exactly the configured number of auto-submitted iterations", () => {
		const config = parseLoopLimitArgs("3");
		expect(config).toEqual({ kind: "iterations", iterations: 3 });
		if (!config || typeof config === "string") throw new Error("expected parsed config");

		const limit = createLoopLimitRuntime(config);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(false);
		expect(limit).toEqual({ kind: "iterations", initial: 3, remaining: 0 });
	});

	test("stops duration-limited loops at the configured deadline", () => {
		const config = parseLoopLimitArgs("10m");
		expect(config).toEqual({ kind: "duration", durationMs: 600_000 });
		if (!config || typeof config === "string") throw new Error("expected parsed config");

		const limit = createLoopLimitRuntime(config, 1_000);
		expect(consumeLoopLimitIteration(limit, 600_999)).toBe(true);
		expect(isLoopDurationExpired(limit, 600_999)).toBe(false);
		expect(consumeLoopLimitIteration(limit, 601_000)).toBe(false);
		expect(isLoopDurationExpired(limit, 601_000)).toBe(true);
	});
});
