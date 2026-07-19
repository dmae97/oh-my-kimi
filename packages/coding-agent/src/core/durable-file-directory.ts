import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, rmdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

export function fsyncDirectorySync(path: string): void {
	if (process.platform === "win32") return;
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function assertDirectorySync(path: string): void {
	if (!statSync(path).isDirectory()) throw new Error(`Durable directory path is not a directory: ${path}`);
}

function syncCreatedDirectoryParent(directory: string, created: boolean): void {
	try {
		fsyncDirectorySync(dirname(directory));
	} catch (error) {
		if (!created) throw error;
		let cleanupError: unknown;
		try {
			rmdirSync(directory);
		} catch (failure) {
			cleanupError = failure instanceof Error ? failure : new Error(String(failure));
		}
		try {
			fsyncDirectorySync(dirname(directory));
		} catch (failure) {
			const syncError = failure instanceof Error ? failure : new Error(String(failure));
			cleanupError = cleanupError ? new AggregateError([cleanupError, syncError]) : syncError;
		}
		if (cleanupError) throw new AggregateError([error, cleanupError], "Durable directory cleanup failed");
		throw error;
	}
}

export function ensureDurableDirectorySync(path: string): void {
	const missing: string[] = [];
	let cursor = path;
	while (!existsSync(cursor)) {
		missing.push(cursor);
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	assertDirectorySync(cursor);
	syncCreatedDirectoryParent(cursor, false);
	for (const directory of missing.reverse()) {
		let created = false;
		try {
			mkdirSync(directory, { mode: 0o700 });
			created = true;
		} catch (error) {
			const code = error instanceof Error && "code" in error ? Reflect.get(error, "code") : undefined;
			if (code !== "EEXIST") throw error;
		}
		assertDirectorySync(directory);
		syncCreatedDirectoryParent(directory, created);
	}
}

export function ensureDurableParentDirectorySync(path: string): void {
	const parent = dirname(path);
	if (!existsSync(parent)) ensureDurableDirectorySync(parent);
}
