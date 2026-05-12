/**
 * Stateless parse worker for `syncAllSessions`. The main thread owns the
 * SQLite handle; workers receive `{ sessionFile, fromOffset }`, run
 * `parseSessionFile` (which is pure I/O + CPU, no DB), and post the
 * structured-clone-safe result back. One in-flight request per worker so
 * the main thread can fan jobs out 1:1 with the pool size.
 */

import { type ParseSessionResult, parseSessionFile } from "./parser";

export interface SyncWorkerRequest {
	sessionFile: string;
	fromOffset: number;
}

export type SyncWorkerResponse = { ok: true; result: ParseSessionResult } | { ok: false; error: string };

declare const self: Worker & {
	onmessage: ((event: MessageEvent<SyncWorkerRequest>) => void) | null;
};

self.onmessage = async event => {
	const { sessionFile, fromOffset } = event.data;
	try {
		const result = await parseSessionFile(sessionFile, fromOffset);
		self.postMessage({ ok: true, result } satisfies SyncWorkerResponse);
	} catch (err) {
		const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		self.postMessage({ ok: false, error } satisfies SyncWorkerResponse);
	}
};
