import * as fs from "node:fs";
import * as path from "node:path";
import {
	type DeadlineProfile,
	type DeadlineProfileDb,
	type DeadlineProfileSample,
	getDeadlineProfile,
	updateDeadlineProfiles,
} from "./deadline-budget.ts";

const MAX_PROFILE_FILE_BYTES = 1024 * 1024;
const MAX_PROFILE_ENTRIES = 1_000;
const LOCK_RETRY_COUNT = 200;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 30_000;

export class DeadlineProfileLockError extends Error {
	constructor(filePath: string) {
		super(`Timed out acquiring deadline profile lock for ${filePath}`);
		this.name = "DeadlineProfileLockError";
	}
}

export class DeadlineProfileStore {
	private readonly filePath: string;
	private db: DeadlineProfileDb = emptyDb();
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async profileFor(provider: string, model: string): Promise<DeadlineProfile | undefined> {
		await this.mutationTail;
		this.db = await readDb(this.filePath);
		return getDeadlineProfile(this.db, provider, model);
	}

	async record(sample: DeadlineProfileSample): Promise<DeadlineProfile> {
		let recorded: DeadlineProfile | undefined;
		const operation = this.mutationTail.then(async () => {
			await withProfileLock(this.filePath, async () => {
				this.db = updateDeadlineProfiles(await readDb(this.filePath), sample);
				recorded = getDeadlineProfile(this.db, sample.provider, sample.model);
				if (recorded === undefined) throw new Error("Deadline profile update did not produce a profile");
				await writeAtomically(this.filePath, JSON.stringify(this.db));
			});
		});
		this.mutationTail = operation.catch(() => undefined);
		await operation;
		if (recorded === undefined) throw new Error("Deadline profile update did not complete");
		return recorded;
	}
}

async function withProfileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = `${filePath}.lock`;
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
		try {
			await fs.promises.mkdir(lockPath);
			try {
				return await operation();
			} finally {
				await fs.promises.rm(lockPath, { recursive: true, force: true });
			}
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			await removeStaleLock(lockPath);
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	throw new DeadlineProfileLockError(filePath);
}

async function removeStaleLock(lockPath: string): Promise<void> {
	try {
		const stats = await fs.promises.stat(lockPath);
		if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
			await fs.promises.rm(lockPath, { recursive: true, force: true });
		}
	} catch {
		return;
	}
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function readDb(filePath: string): Promise<DeadlineProfileDb> {
	try {
		const handle = await fs.promises.open(filePath, "r");
		try {
			const stats = await handle.stat();
			if (stats.size > MAX_PROFILE_FILE_BYTES) return emptyDb();
			return parseDb(JSON.parse(await handle.readFile("utf8")));
		} finally {
			await handle.close();
		}
	} catch {
		return emptyDb();
	}
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
	try {
		await fs.promises.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
		await fs.promises.rename(tempPath, filePath);
	} finally {
		await fs.promises.rm(tempPath, { force: true });
	}
}

function parseDb(value: unknown): DeadlineProfileDb {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.profiles)) return emptyDb();
	const profiles: Record<string, DeadlineProfile> = Object.create(null);
	for (const [key, raw] of Object.entries(value.profiles).slice(0, MAX_PROFILE_ENTRIES)) {
		const parsed = parseProfile(raw);
		if (parsed !== undefined) profiles[key] = parsed;
	}
	return { version: 1, profiles };
}

function parseProfile(value: unknown): DeadlineProfile | undefined {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
	const samples = readCount(value.samples);
	const completions = readCount(value.completions);
	const cutoffs = readCount(value.cutoffs);
	const aborts = readCount(value.aborts);
	const failures = readCount(value.failures);
	const ewmaElapsedMs = readCount(value.ewmaElapsedMs);
	const ewmaMsPerWorkUnit = readCount(value.ewmaMsPerWorkUnit);
	if ([samples, completions, cutoffs, aborts, failures, ewmaElapsedMs, ewmaMsPerWorkUnit].includes(undefined)) {
		return undefined;
	}
	return {
		provider: value.provider.slice(0, 256),
		model: value.model.slice(0, 256),
		samples: samples ?? 0,
		completions: completions ?? 0,
		cutoffs: cutoffs ?? 0,
		aborts: aborts ?? 0,
		failures: failures ?? 0,
		ewmaElapsedMs: ewmaElapsedMs ?? 0,
		ewmaMsPerWorkUnit: ewmaMsPerWorkUnit ?? 0,
		completedDurationsMs: readDurations(value.completedDurationsMs),
		cutoffDurationsMs: readDurations(value.cutoffDurationsMs),
	};
}

function readCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function readDurations(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(readCount)
		.filter((duration): duration is number => duration !== undefined && duration > 0)
		.slice(-24);
}

function emptyDb(): DeadlineProfileDb {
	return { version: 1, profiles: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
