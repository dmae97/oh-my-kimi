export interface LoopRecord {
	readonly toolName: string;
	readonly args: unknown;
}

export interface LoopPolicy {
	readonly warnAfter?: number;
	readonly stopAfter?: number;
}

export interface LoopDetection {
	readonly kind: "warn" | "stop";
	readonly toolName: string;
	readonly count: number;
}

function signature(record: LoopRecord): string {
	return `${record.toolName}:${stableJson(record.args)}`;
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

export function detectIdenticalLoop(
	records: readonly LoopRecord[],
	policy: LoopPolicy = {},
): LoopDetection | undefined {
	const warnAfter = policy.warnAfter ?? 3;
	const stopAfter = policy.stopAfter ?? 6;
	if (records.length === 0) return undefined;
	const last = records[records.length - 1];
	if (!last) return undefined;
	const target = signature(last);
	let count = 0;
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index];
		if (!record || signature(record) !== target) break;
		count += 1;
	}
	if (count >= stopAfter) return { kind: "stop", toolName: last.toolName, count };
	if (count >= warnAfter) return { kind: "warn", toolName: last.toolName, count };
	return undefined;
}
