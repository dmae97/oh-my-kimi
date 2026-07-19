import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ReplayLedgerHead } from "../types/evidence.ts";
import { fsyncDirectory, ReplayLedgerLock, writeAll } from "./replay-ledger-lock.ts";
import { quarantineReplayLedgerSuffix } from "./replay-ledger-quarantine.ts";

const GENESIS_HASH = "genesis";
export const EMPTY_REPLAY_LEDGER_HEAD: ReplayLedgerHead = Object.freeze({
	fileIdentity: null,
	size: 0,
	lastSeq: 0,
	lastHash: GENESIS_HASH,
});
interface InspectedLedger {
	readonly lastSeq: number;
	readonly lastHash: string;
}
interface StoreSnapshot {
	readonly bytes: Buffer;
	readonly head: ReplayLedgerHead;
}
function identity(stat: ReturnType<typeof fstatSync>): ReplayLedgerHead["fileIdentity"] {
	return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left: ReplayLedgerHead["fileIdentity"], right: ReplayLedgerHead["fileIdentity"]): boolean {
	return left === null ? right === null : right !== null && left.dev === right.dev && left.ino === right.ino;
}

export function replayLedgerHeadsEqual(left: ReplayLedgerHead, right: ReplayLedgerHead): boolean {
	return (
		sameIdentity(left.fileIdentity, right.fileIdentity) &&
		left.size === right.size &&
		left.lastSeq === right.lastSeq &&
		left.lastHash === right.lastHash
	);
}

function parseHead(value: unknown): ReplayLedgerHead {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("replay committed head is invalid");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "fileIdentity,lastHash,lastSeq,size") {
		throw new Error("replay committed head has an invalid key set");
	}
	const rawIdentity = record.fileIdentity;
	let fileIdentity: ReplayLedgerHead["fileIdentity"] = null;
	if (rawIdentity !== null) {
		if (typeof rawIdentity !== "object" || Array.isArray(rawIdentity))
			throw new Error("replay file identity is invalid");
		const fields = rawIdentity as Record<string, unknown>;
		if (
			Object.keys(fields).sort().join(",") !== "dev,ino" ||
			typeof fields.dev !== "string" ||
			typeof fields.ino !== "string" ||
			!/^\d+$/.test(fields.dev) ||
			!/^\d+$/.test(fields.ino)
		) {
			throw new Error("replay file identity is invalid");
		}
		fileIdentity = Object.freeze({ dev: fields.dev, ino: fields.ino });
	}
	if (
		!Number.isSafeInteger(record.size) ||
		(record.size as number) < 0 ||
		!Number.isSafeInteger(record.lastSeq) ||
		(record.lastSeq as number) < 0 ||
		typeof record.lastHash !== "string" ||
		(record.lastSeq === 0 ? record.lastHash !== GENESIS_HASH : !/^[0-9a-f]{64}$/.test(record.lastHash))
	) {
		throw new Error("replay committed head fields are invalid");
	}
	return Object.freeze({
		fileIdentity,
		size: record.size as number,
		lastSeq: record.lastSeq as number,
		lastHash: record.lastHash,
	});
}

export interface ReplayLedgerStoreOptions {
	readonly afterLedgerFsync?: () => void;
	readonly beforeQuarantineFsync?: () => void;
}

export class ReplayLedgerStore {
	private readonly path: string;
	private readonly inspect: (bytes: Buffer) => InspectedLedger;
	private readonly headPath: string;
	private readonly lock: ReplayLedgerLock;
	private readonly afterLedgerFsync: (() => void) | undefined;
	private readonly beforeQuarantineFsync: (() => void) | undefined;

	constructor(path: string, inspect: (bytes: Buffer) => InspectedLedger, options: ReplayLedgerStoreOptions = {}) {
		this.path = path;
		this.inspect = inspect;
		mkdirSync(dirname(path), { recursive: true });
		this.headPath = `${path}.head`;
		this.lock = new ReplayLedgerLock(`${path}.lock`);
		this.afterLedgerFsync = options.afterLedgerFsync;
		this.beforeQuarantineFsync = options.beforeQuarantineFsync;
	}

	private withLock<T>(operation: () => T): T {
		return this.lock.run(operation);
	}

	private readVerified(): StoreSnapshot {
		const ledgerExists = existsSync(this.path);
		const headExists = existsSync(this.headPath);
		if (!ledgerExists && !headExists) return { bytes: Buffer.alloc(0), head: EMPTY_REPLAY_LEDGER_HEAD };
		if (ledgerExists && !headExists) {
			const fd = openSync(this.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile() || stat.size !== 0) throw new Error("replay ledger or committed head suffix is missing");
			} finally {
				closeSync(fd);
			}
			unlinkSync(this.path);
			fsyncDirectory(dirname(this.path));
			return { bytes: Buffer.alloc(0), head: EMPTY_REPLAY_LEDGER_HEAD };
		}
		if (!ledgerExists) throw new Error("replay ledger or committed head suffix is missing");
		const head = parseHead(JSON.parse(readFileSync(this.headPath, "utf8")));
		const fd = openSync(this.path, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
		try {
			const before = fstatSync(fd);
			const bytes = readFileSync(fd);
			const after = fstatSync(fd);
			if (
				!before.isFile() ||
				!after.isFile() ||
				!sameIdentity(identity(before), identity(after)) ||
				before.size !== after.size ||
				after.size !== bytes.byteLength ||
				!sameIdentity(head.fileIdentity, identity(after)) ||
				head.size > after.size
			) {
				throw new Error("replay ledger tampered: file identity or size does not match its committed head");
			}
			const committedBytes = head.size === after.size ? bytes : bytes.subarray(0, head.size);
			const inspected = this.inspect(committedBytes);
			if (inspected.lastSeq !== head.lastSeq || inspected.lastHash !== head.lastHash) {
				throw new Error("replay ledger suffix does not match its committed head");
			}
			if (head.size < after.size) {
				quarantineReplayLedgerSuffix(this.path, bytes.subarray(head.size), this.beforeQuarantineFsync);
				ftruncateSync(fd, head.size);
				fsyncSync(fd);
				fsyncDirectory(dirname(this.path));
			}
			return { bytes: committedBytes, head };
		} finally {
			closeSync(fd);
		}
	}

	private initializeGenesis(): ReplayLedgerHead {
		const fd = openSync(this.path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
		try {
			fsyncSync(fd);
			const stat = fstatSync(fd);
			const head = Object.freeze({ ...EMPTY_REPLAY_LEDGER_HEAD, fileIdentity: identity(stat) });
			this.publishHead(head);
			return head;
		} finally {
			closeSync(fd);
		}
	}

	private publishHead(head: ReplayLedgerHead): void {
		const temp = `${this.headPath}.${randomUUID()}.tmp`;
		const fd = openSync(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
		try {
			writeAll(fd, Buffer.from(`${JSON.stringify(head)}\n`, "utf8"));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			renameSync(temp, this.headPath);
			fsyncDirectory(dirname(this.path));
		} catch (error) {
			if (existsSync(temp)) unlinkSync(temp);
			throw error;
		}
	}

	load(expectedHead?: ReplayLedgerHead): StoreSnapshot {
		return this.withLock(() => {
			const snapshot = this.readVerified();
			if (expectedHead !== undefined && !replayLedgerHeadsEqual(snapshot.head, expectedHead)) {
				throw new Error("replay ledger expected-head CAS verification failed");
			}
			return snapshot;
		});
	}

	append(line: Buffer, nextSeq: number, nextHash: string, expectedHead: ReplayLedgerHead): ReplayLedgerHead {
		return this.withLock(() => {
			const snapshot = this.readVerified();
			if (!replayLedgerHeadsEqual(snapshot.head, expectedHead)) {
				throw new Error("replay ledger concurrent append failed expected-head CAS");
			}
			const appendHead = snapshot.head.fileIdentity === null ? this.initializeGenesis() : snapshot.head;
			const fd = openSync(
				this.path,
				fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
				0o600,
			);
			try {
				const before = fstatSync(fd);
				if (before.size !== appendHead.size || !sameIdentity(appendHead.fileIdentity, identity(before))) {
					throw new Error("replay ledger file identity or size changed before CAS append");
				}
				writeAll(fd, line);
				fsyncSync(fd);
				const after = fstatSync(fd);
				if (!sameIdentity(identity(before), identity(after)) || after.size !== appendHead.size + line.byteLength) {
					throw new Error("replay ledger file changed during CAS append");
				}
				const head = Object.freeze({
					fileIdentity: identity(after),
					size: after.size,
					lastSeq: nextSeq,
					lastHash: nextHash,
				});
				this.afterLedgerFsync?.();
				this.publishHead(head);
				return head;
			} finally {
				closeSync(fd);
			}
		});
	}
}
