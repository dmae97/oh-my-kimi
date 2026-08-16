import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type ApprovalReceipt, serializeApprovalReceipt, validateApprovalReceipt } from "./approval-receipt.ts";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface ApprovalReceiptWriteResult {
	path: string;
	created: boolean;
}

interface RootIdentity {
	dev: number;
	ino: number;
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function assertOwnedByCurrentUser(uid: number, label: string): void {
	const getuid = process.getuid;
	if (typeof getuid === "function" && uid !== getuid()) {
		throw new Error(`${label} is not owned by the current user`);
	}
}

function receiptFileName(receiptId: string): string {
	if (!/^approval-[a-f0-9]{32}$/u.test(receiptId)) throw new Error("Approval receipt id is invalid");
	return `${receiptId}.json`;
}

function assertPrivateReceiptFd(fd: number, filePath: string): void {
	const stat = fstatSync(fd);
	if (!stat.isFile()) throw new Error(`Approval receipt is not a regular file: ${filePath}`);
	if (stat.nlink !== 1) throw new Error(`Approval receipt must not be hard-linked: ${filePath}`);
	assertOwnedByCurrentUser(stat.uid, `Approval receipt ${filePath}`);
	if ((stat.mode & 0o777) !== 0o600) {
		throw new Error(`Approval receipt permissions must be 0600: ${filePath}`);
	}
	if (stat.size > MAX_RECEIPT_BYTES) throw new Error(`Approval receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
}

function readReceiptFromFd(fd: number, filePath: string): ApprovalReceipt {
	assertPrivateReceiptFd(fd, filePath);
	const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
		if (read === 0) break;
		offset += read;
	}
	if (offset > MAX_RECEIPT_BYTES) throw new Error(`Approval receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
	assertPrivateReceiptFd(fd, filePath);
	let value: unknown;
	try {
		value = JSON.parse(buffer.subarray(0, offset).toString("utf8")) as unknown;
	} catch {
		throw new Error(`Approval receipt is not valid JSON: ${filePath}`);
	}
	return validateApprovalReceipt(value);
}

export class ApprovalReceiptStore {
	readonly rootDir: string;

	constructor(rootDir: string) {
		this.rootDir = resolve(rootDir);
		this.ensurePrivateDirectory();
	}

	private ensurePrivateDirectory(): RootIdentity {
		mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
		const stat = lstatSync(this.rootDir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Approval receipt root must be a real directory: ${this.rootDir}`);
		}
		assertOwnedByCurrentUser(stat.uid, `Approval receipt root ${this.rootDir}`);
		if ((stat.mode & 0o777) !== 0o700) {
			throw new Error(`Approval receipt root permissions must be 0700: ${this.rootDir}`);
		}
		return { dev: stat.dev, ino: stat.ino };
	}

	private assertRootUnchanged(expected: RootIdentity): void {
		const current = this.ensurePrivateDirectory();
		if (current.dev !== expected.dev || current.ino !== expected.ino) {
			throw new Error("Approval receipt root changed during the operation");
		}
	}

	private pathFor(receiptId: string): string {
		return join(this.rootDir, receiptFileName(receiptId));
	}

	private openReceiptForRead(filePath: string): number {
		const fd = openSync(filePath, constants.O_RDONLY | NOFOLLOW);
		try {
			assertPrivateReceiptFd(fd, filePath);
			return fd;
		} catch (error) {
			closeSync(fd);
			throw error;
		}
	}

	write(receipt: ApprovalReceipt): ApprovalReceiptWriteResult {
		const validated = validateApprovalReceipt(receipt);
		const rootIdentity = this.ensurePrivateDirectory();
		const filePath = this.pathFor(validated.core.receiptId);
		const canonical = serializeApprovalReceipt(validated);
		const bytes = Buffer.from(canonical, "utf8");
		if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new Error(`Approval receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);

		// Explicit existence/symlink pre-check. O_EXCL/O_NOFOLLOW are honored on
		// proper Linux but silently ignored on some platforms (e.g. WSL2), which
		// would silently void the never-overwrite and symlink-rejection invariants
		// (hard rule: no silent degraded operation). Enforce them via lstat so the
		// guarantees hold on every platform; O_EXCL below stays as the atomic
		// backstop for the create path on capable platforms.
		let existingStat: ReturnType<typeof lstatSync> | null = null;
		try {
			existingStat = lstatSync(filePath);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		if (existingStat !== null) {
			if (existingStat.isSymbolicLink()) {
				throw new Error(`Approval receipt must not be a symbolic link: ${filePath}`);
			}
			const prior = this.read(validated.core.receiptId);
			if (serializeApprovalReceipt(prior) !== canonical) {
				throw new Error(
					`Approval receipt already exists with different content and is never overwritten: ${validated.core.receiptId}`,
				);
			}
			this.assertRootUnchanged(rootIdentity);
			return { path: filePath, created: false };
		}

		let fd: number;
		try {
			fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			const existing = this.read(validated.core.receiptId);
			if (serializeApprovalReceipt(existing) !== canonical) {
				throw new Error(
					`Approval receipt already exists with different content and is never overwritten: ${validated.core.receiptId}`,
				);
			}
			this.assertRootUnchanged(rootIdentity);
			return { path: filePath, created: false };
		}

		try {
			fchmodSync(fd, 0o600);
			assertPrivateReceiptFd(fd, filePath);
			writeFileSync(fd, bytes);
			fsyncSync(fd);
			assertPrivateReceiptFd(fd, filePath);
		} finally {
			closeSync(fd);
		}
		this.assertRootUnchanged(rootIdentity);
		return { path: filePath, created: true };
	}

	has(receiptId: string): boolean {
		const rootIdentity = this.ensurePrivateDirectory();
		let fd: number;
		try {
			fd = this.openReceiptForRead(this.pathFor(receiptId));
		} catch (error) {
			if (isErrno(error, "ENOENT")) {
				this.assertRootUnchanged(rootIdentity);
				return false;
			}
			throw error;
		}
		closeSync(fd);
		this.assertRootUnchanged(rootIdentity);
		return true;
	}

	read(receiptId: string): ApprovalReceipt {
		const rootIdentity = this.ensurePrivateDirectory();
		const filePath = this.pathFor(receiptId);
		const fd = this.openReceiptForRead(filePath);
		try {
			return readReceiptFromFd(fd, filePath);
		} finally {
			closeSync(fd);
			this.assertRootUnchanged(rootIdentity);
		}
	}

	listReceiptIds(): string[] {
		const rootIdentity = this.ensurePrivateDirectory();
		const ids = readdirSync(this.rootDir)
			.map((name) => /^(approval-[a-f0-9]{32})\.json$/u.exec(name)?.[1])
			.filter((id): id is string => id !== undefined)
			.sort((left, right) => left.localeCompare(right));
		for (const id of ids) this.has(id);
		this.assertRootUnchanged(rootIdentity);
		return ids;
	}
}
