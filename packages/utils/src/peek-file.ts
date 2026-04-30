/**
 * Read the first `maxBytes` of a file (offset 0) and pass that slice to `op`.
 *
 * Buffers are reused to avoid allocating on every peek: sync uses one growable
 * `Uint8Array`; async uses a small fixed pool of `Buffer`s with a bounded wait
 * queue, falling back to a fresh allocation when the pool and queue are saturated
 * or when `maxBytes` exceeds the pool slot size.
 */
import * as fs from "node:fs";

/** Async pool slot size; larger peeks allocate ad hoc. */
const POOLED_BUFFER_SIZE = 512;
const ASYNC_POOL_SIZE = 10;
/** Cap waiter queue so heavy concurrency does not queue unbounded; overflow uses alloc. */
const MAX_ASYNC_WAITERS = 4;
const INITIAL_SYNC_BUFFER_SIZE = 1024;
const EMPTY_BUFFER = Buffer.alloc(0);

const asyncPool = Array.from({ length: ASYNC_POOL_SIZE }, () => Buffer.allocUnsafe(POOLED_BUFFER_SIZE));
const availableAsyncPoolIndexes = Array.from({ length: ASYNC_POOL_SIZE }, (_, index) => index);
const asyncPoolWaiters: Array<(index: number) => void> = [];
let syncPool = new Uint8Array(INITIAL_SYNC_BUFFER_SIZE);

/** Returns a pool slot index, or `-1` when the caller should use a standalone buffer. */
function acquireAsyncPoolIndex(): Promise<number> | number {
	const index = availableAsyncPoolIndexes.pop();
	if (index !== undefined) {
		return index;
	}
	if (asyncPoolWaiters.length >= MAX_ASYNC_WAITERS) {
		return -1;
	}
	const { promise, resolve } = Promise.withResolvers<number>();
	asyncPoolWaiters.push(resolve);
	return promise;
}

function releaseAsyncPoolIndex(index: number): void {
	if (index < 0) {
		return;
	}
	const waiter = asyncPoolWaiters.shift();
	if (waiter) {
		waiter(index);
		return;
	}
	availableAsyncPoolIndexes.push(index);
}

async function withAsyncPoolBuffer<T>(maxBytes: number, op: (buffer: Buffer) => Promise<T>): Promise<T> {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}
	if (maxBytes > POOLED_BUFFER_SIZE) {
		return op(Buffer.allocUnsafe(maxBytes));
	}

	const poolIndex = await acquireAsyncPoolIndex();
	const buffer = poolIndex >= 0 ? asyncPool[poolIndex] : Buffer.allocUnsafe(maxBytes);
	try {
		return await op(buffer.subarray(0, maxBytes));
	} finally {
		releaseAsyncPoolIndex(poolIndex);
	}
}

function withSyncPoolBuffer<T>(maxBytes: number, op: (buffer: Uint8Array) => T): T {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}
	if (maxBytes > syncPool.byteLength) {
		syncPool = new Uint8Array(maxBytes + (maxBytes >> 1));
	}
	return op(syncPool.subarray(0, maxBytes));
}

/**
 * Synchronously reads up to `maxBytes` from the start of `filePath` and returns `op(header)`.
 * If the file is shorter, `header` is only the bytes actually read.
 */
export function peekFileSync<T>(filePath: string, maxBytes: number, op: (header: Uint8Array) => T): T {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}

	const fileHandle = fs.openSync(filePath, "r");
	try {
		return withSyncPoolBuffer(maxBytes, buffer => {
			const bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.byteLength, 0);
			return op(buffer.subarray(0, bytesRead));
		});
	} finally {
		fs.closeSync(fileHandle);
	}
}

/**
 * Like {@link peekFileSync} but uses async I/O.
 */
export async function peekFile<T>(filePath: string, maxBytes: number, op: (header: Uint8Array) => T): Promise<T> {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}

	const fileHandle = await fs.promises.open(filePath, "r");
	try {
		return await withAsyncPoolBuffer(maxBytes, async buffer => {
			const { bytesRead } = await fileHandle.read(buffer, 0, buffer.byteLength, 0);
			return op(buffer.subarray(0, bytesRead));
		});
	} finally {
		await fileHandle.close();
	}
}
