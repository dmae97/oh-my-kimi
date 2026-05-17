import { readSseEvents, type ServerSentEvent } from "@oh-my-pi/pi-utils";
import type { RawSseEvent } from "../types";

type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchWithPreconnect = FetchFunction & { preconnect?: typeof fetch.preconnect };

type RawSseObserver = (event: RawSseEvent) => void;

export function notifyRawSseEvent(observer: RawSseObserver | undefined, event: ServerSentEvent | RawSseEvent): void {
	if (!observer) return;
	try {
		// Defensive clone: observers may retain `raw` (e.g. session debug buffer).
		observer({ event: event.event, data: event.data, raw: [...event.raw] });
	} catch {
		// Raw stream observers are diagnostic only and must not affect generation.
	}
}

function isSseResponse(response: Response): boolean {
	if (!response.ok || !response.body) return false;
	const contentType = response.headers.get("content-type");
	if (!contentType) return false;
	// Fast path: most servers emit lowercase `text/event-stream`. Only pay
	// for `toLowerCase` when the header is not already canonical.
	if (contentType.includes("text/event-stream")) return true;
	return contentType.toLowerCase().includes("text/event-stream");
}

async function consumeRawSseStream(stream: ReadableStream<Uint8Array>, observer: RawSseObserver): Promise<void> {
	try {
		for await (const event of readSseEvents(stream)) {
			// Pass the parsed event directly; `notifyRawSseEvent` performs the single
			// defensive clone. Previously this path cloned `raw` twice per event.
			notifyRawSseEvent(observer, event);
		}
	} catch {
		// The consumer branch may cancel/abort the original response. Debug capture is best-effort.
	}
}

export function wrapFetchForSseDebug(
	fetchImpl: FetchWithPreconnect,
	observer: RawSseObserver | undefined,
): FetchWithPreconnect {
	if (!observer) return fetchImpl;

	const wrapped = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const response = await fetchImpl(input, init);
			if (!isSseResponse(response)) {
				return response;
			}

			const body = response.body;
			if (!body) return response;

			const [debugBody, consumerBody] = body.tee();
			void consumeRawSseStream(debugBody, observer);

			return new Response(consumerBody, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		},
		fetchImpl.preconnect ? { preconnect: fetchImpl.preconnect } : {},
	);

	return wrapped;
}
