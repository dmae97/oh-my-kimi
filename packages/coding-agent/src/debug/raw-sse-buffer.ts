import type { Model, ProviderResponseMetadata, RawSseEvent } from "@oh-my-pi/pi-ai";

const MAX_RAW_SSE_EVENTS = 1_000;
const MAX_RAW_SSE_CHARS = 512_000;
const MAX_RAW_SSE_EVENT_CHARS = 64_000;

export type RawSseDebugRecord =
	| {
			kind: "response";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			status: number;
			requestId?: string | null;
			transport?: string;
	  }
	| {
			kind: "event";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			event: string | null;
			raw: string[];
			truncated: boolean;
			originalChars: number;
	  };

export interface RawSseDebugSnapshot {
	records: readonly RawSseDebugRecord[];
	droppedRecords: number;
	droppedChars: number;
	totalEvents: number;
	lastUpdatedAt?: number;
}

function modelProvider(model: Model | undefined): string | undefined {
	return model?.provider;
}

function modelId(model: Model | undefined): string | undefined {
	return model?.id;
}

function modelApi(model: Model | undefined): string | undefined {
	return model?.api;
}

function countRecordChars(record: RawSseDebugRecord): number {
	if (record.kind === "response") return formatRawSseResponseComment(record).length + 1;
	return record.raw.reduce((sum, line) => sum + line.length + 1, 1);
}

function trimRawLines(raw: string[]): { raw: string[]; truncated: boolean; originalChars: number } {
	const originalChars = raw.reduce((sum, line) => sum + line.length + 1, 0);
	if (originalChars <= MAX_RAW_SSE_EVENT_CHARS) {
		return { raw: [...raw], truncated: false, originalChars };
	}

	const trimmed: string[] = [];
	let remaining = MAX_RAW_SSE_EVENT_CHARS;
	for (const line of raw) {
		if (remaining <= 0) break;
		if (line.length + 1 <= remaining) {
			trimmed.push(line);
			remaining -= line.length + 1;
			continue;
		}
		trimmed.push(line.slice(0, Math.max(0, remaining)));
		remaining = 0;
	}
	trimmed.push(`: omp-debug-truncated originalChars=${originalChars}`);
	return { raw: trimmed, truncated: true, originalChars };
}

export function formatRawSseIsoTime(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

export function formatRawSseResponseComment(record: Extract<RawSseDebugRecord, { kind: "response" }>): string {
	const fields = [
		"omp-response",
		`ts=${formatRawSseIsoTime(record.timestamp)}`,
		`status=${record.status}`,
		record.provider ? `provider=${record.provider}` : undefined,
		record.model ? `model=${record.model}` : undefined,
		record.api ? `api=${record.api}` : undefined,
		record.requestId ? `requestId=${record.requestId}` : undefined,
		record.transport ? `transport=${record.transport}` : undefined,
	].filter((field): field is string => field !== undefined);
	return `: ${fields.join(" ")}`;
}

export function rawSseRecordLines(record: RawSseDebugRecord): string[] {
	if (record.kind === "response") return [formatRawSseResponseComment(record)];
	return record.raw;
}

function rawRecordText(record: RawSseDebugRecord): string {
	return `${rawSseRecordLines(record).join("\n")}\n`;
}

function metadataTransport(response: ProviderResponseMetadata): string | undefined {
	const value = response.metadata?.lastTransport;
	return typeof value === "string" ? value : undefined;
}

export class RawSseDebugBuffer {
	#records: RawSseDebugRecord[] = [];
	#totalChars = 0;
	#droppedRecords = 0;
	#droppedChars = 0;
	#totalEvents = 0;
	#lastUpdatedAt: number | undefined;
	#nextSequence = 1;
	#listeners = new Set<() => void>();

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	recordResponse(response: ProviderResponseMetadata, model?: Model): void {
		this.#append({
			kind: "response",
			sequence: this.#nextSequence++,
			timestamp: Date.now(),
			provider: modelProvider(model),
			model: modelId(model),
			api: modelApi(model),
			status: response.status,
			requestId: response.requestId,
			transport: metadataTransport(response),
		});
	}

	recordEvent(event: RawSseEvent, model?: Model): void {
		const trimmed = trimRawLines(event.raw);
		this.#totalEvents += 1;
		this.#append({
			kind: "event",
			sequence: this.#nextSequence++,
			timestamp: Date.now(),
			provider: modelProvider(model),
			model: modelId(model),
			api: modelApi(model),
			event: event.event,
			raw: trimmed.raw,
			truncated: trimmed.truncated,
			originalChars: trimmed.originalChars,
		});
	}

	snapshot(): RawSseDebugSnapshot {
		return {
			records: [...this.#records],
			droppedRecords: this.#droppedRecords,
			droppedChars: this.#droppedChars,
			totalEvents: this.#totalEvents,
			lastUpdatedAt: this.#lastUpdatedAt,
		};
	}

	toRawText(): string {
		return this.#records.map(rawRecordText).join("\n");
	}

	#append(record: RawSseDebugRecord): void {
		const chars = countRecordChars(record);
		this.#records.push(record);
		this.#totalChars += chars;
		this.#lastUpdatedAt = record.timestamp;
		this.#enforceLimits();
		this.#emit();
	}

	#enforceLimits(): void {
		while (this.#records.length > MAX_RAW_SSE_EVENTS || this.#totalChars > MAX_RAW_SSE_CHARS) {
			const dropped = this.#records.shift();
			if (!dropped) return;
			const chars = countRecordChars(dropped);
			this.#totalChars = Math.max(0, this.#totalChars - chars);
			this.#droppedRecords += 1;
			this.#droppedChars += chars;
		}
	}

	#emit(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// Debug viewers must not be able to break stream capture.
			}
		}
	}
}

const fallbackBuffers = new WeakMap<object, RawSseDebugBuffer>();
const globalFallbackBuffer = new RawSseDebugBuffer();

export function resolveRawSseDebugBuffer(owner?: object): RawSseDebugBuffer {
	if (!owner) return globalFallbackBuffer;

	const candidate = (owner as { rawSseDebugBuffer?: unknown }).rawSseDebugBuffer;
	if (candidate instanceof RawSseDebugBuffer) return candidate;

	const existing = fallbackBuffers.get(owner);
	if (existing) return existing;

	const buffer = new RawSseDebugBuffer();
	fallbackBuffers.set(owner, buffer);
	if (Object.isExtensible(owner)) {
		try {
			Object.defineProperty(owner, "rawSseDebugBuffer", {
				value: buffer,
				configurable: true,
				enumerable: false,
				writable: true,
			});
		} catch {
			// The WeakMap fallback remains usable if the session object rejects extension.
		}
	}
	return buffer;
}
