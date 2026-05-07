export type LoopLimitConfig =
	| {
			kind: "iterations";
			iterations: number;
	  }
	| {
			kind: "duration";
			durationMs: number;
	  };

export type LoopLimitRuntime =
	| {
			kind: "iterations";
			initial: number;
			remaining: number;
	  }
	| {
			kind: "duration";
			durationMs: number;
			deadlineMs: number;
	  };

const TIME_UNITS_MS = new Map<string, number>([
	["s", 1_000],
	["sec", 1_000],
	["secs", 1_000],
	["second", 1_000],
	["seconds", 1_000],
	["m", 60_000],
	["min", 60_000],
	["mins", 60_000],
	["minute", 60_000],
	["minutes", 60_000],
	["h", 3_600_000],
	["hr", 3_600_000],
	["hrs", 3_600_000],
	["hour", 3_600_000],
	["hours", 3_600_000],
]);

export function parseLoopLimitArgs(args: string): LoopLimitConfig | undefined | string {
	const trimmed = args.trim().toLowerCase();
	if (!trimmed) return undefined;

	const parts = trimmed.split(/\s+/);
	if (parts.length > 2) {
		return "Usage: /loop [count|duration]. Examples: /loop 10, /loop 10m, /loop 10min.";
	}

	if (parts.length === 2) {
		return parseDurationParts(parts[0], parts[1]);
	}

	const token = parts[0];
	const iterationMatch = /^(\d+)$/.exec(token);
	if (iterationMatch) {
		const iterations = Number(iterationMatch[1]);
		if (!Number.isSafeInteger(iterations) || iterations <= 0) {
			return "Loop count must be a positive integer.";
		}
		return { kind: "iterations", iterations };
	}

	const durationMatch = /^(\d+)([a-z]+)$/.exec(token);
	if (durationMatch) {
		return parseDurationParts(durationMatch[1], durationMatch[2]);
	}

	return "Usage: /loop [count|duration]. Examples: /loop 10, /loop 10m, /loop 10min.";
}

function parseDurationParts(amountText: string, unitText: string): LoopLimitConfig | string {
	if (!/^\d+$/.test(amountText)) {
		return "Loop duration must use a positive integer amount.";
	}

	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		return "Loop duration must be positive.";
	}

	const unitMs = TIME_UNITS_MS.get(unitText);
	if (unitMs === undefined) {
		return "Loop duration unit must be seconds, minutes, or hours.";
	}

	return { kind: "duration", durationMs: amount * unitMs };
}

export function createLoopLimitRuntime(
	config: LoopLimitConfig | undefined,
	nowMs = Date.now(),
): LoopLimitRuntime | undefined {
	if (!config) return undefined;
	if (config.kind === "iterations") {
		return { kind: "iterations", initial: config.iterations, remaining: config.iterations };
	}
	return { kind: "duration", durationMs: config.durationMs, deadlineMs: nowMs + config.durationMs };
}

export function consumeLoopLimitIteration(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	if (!limit) return true;
	if (limit.kind === "duration") {
		return nowMs < limit.deadlineMs;
	}
	if (limit.remaining <= 0) return false;
	limit.remaining -= 1;
	return true;
}

export function isLoopDurationExpired(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	return limit?.kind === "duration" && nowMs >= limit.deadlineMs;
}

export function describeLoopLimit(config: LoopLimitConfig): string {
	if (config.kind === "iterations") {
		return `${config.iterations} ${config.iterations === 1 ? "iteration" : "iterations"}`;
	}
	return formatDuration(config.durationMs);
}

export function describeLoopLimitRuntime(limit: LoopLimitRuntime): string {
	if (limit.kind === "iterations") {
		return `${limit.remaining} of ${limit.initial} ${limit.initial === 1 ? "iteration" : "iterations"} remaining`;
	}
	return `${formatDuration(limit.durationMs)} limit`;
}

function formatDuration(durationMs: number): string {
	if (durationMs % 3_600_000 === 0) {
		const hours = durationMs / 3_600_000;
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	if (durationMs % 60_000 === 0) {
		const minutes = durationMs / 60_000;
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	const seconds = durationMs / 1_000;
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
