import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EvidenceReceipt } from "../types/evidence.ts";
import {
	isSafeEvidenceReceiptId,
	parseEvidenceReceipt,
	serializeEvidenceReceipt,
	validateEvidenceReceipt,
} from "./evidence-receipt.ts";

export type EvidenceReceiptStoreFaultStage =
	| "before-root-parent-directory-fsync"
	| "after-receipt-directory"
	| "after-temp-open"
	| "after-temp-write"
	| "after-temp-fsync"
	| "after-temp-close"
	| "before-link"
	| "after-link"
	| "after-temp-unlink"
	| "before-temp-cleanup-directory-fsync"
	| "before-receipt-directory-cleanup-root-fsync"
	| "after-receipt-directory-fsync"
	| "after-root-directory-fsync";

export interface EvidenceReceiptStoreOptions {
	/** Tests only: throw or mutate paths at a selected persistence stage. */
	readonly faultInjector?: (stage: EvidenceReceiptStoreFaultStage) => void;
}

type FileStat = Stats;

interface FileIdentity {
	readonly dev: number;
	readonly ino: number;
}

interface DirectoryIdentity {
	readonly path: string;
	readonly identity: FileIdentity;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

const UNSUPPORTED_DIRECTORY_FSYNC_CODES: ReadonlySet<string> = new Set([
	"EBADF",
	"EINVAL",
	"EISDIR",
	"ENOSYS",
	"ENOTSUP",
]);

function classifiedDirectoryFsyncError(path: string, error: unknown): unknown {
	const code = errorCode(error);
	if (code === undefined || !UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)) return error;
	return new Error(`receipt store strict durability unavailable: directory fsync unsupported for ${path} (${code})`, {
		cause: error,
	});
}

function fsyncDirectory(path: string): void {
	let fd: number | undefined;
	let failure: unknown;
	try {
		fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
		fsyncSync(fd);
	} catch (error) {
		failure = classifiedDirectoryFsyncError(path, error);
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch (error) {
				if (failure === undefined) failure = error;
			}
		}
	}
	if (failure !== undefined) throw failure;
}

function writeAll(fd: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
		if (written <= 0) throw new Error("receipt store could not complete the file write");
		offset += written;
	}
}

function identityFrom(stat: FileStat): FileIdentity {
	return { dev: stat.dev, ino: stat.ino };
}

function hasFileIdentity(identity: FileIdentity): boolean {
	return identity.dev !== 0 || identity.ino !== 0;
}

function matchesFileIdentity(expected: FileIdentity, actual: FileStat): boolean {
	const actualIdentity = identityFrom(actual);
	const expectedHasIdentity = hasFileIdentity(expected);
	const actualHasIdentity = hasFileIdentity(actualIdentity);
	return (
		(!expectedHasIdentity && !actualHasIdentity) ||
		(expectedHasIdentity &&
			actualHasIdentity &&
			expected.dev === actualIdentity.dev &&
			expected.ino === actualIdentity.ino)
	);
}

function missingDirectoryPaths(path: string): string[] {
	const missing: string[] = [];
	let current = path;
	while (true) {
		try {
			lstatSync(current);
			return missing;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			missing.push(current);
			const parent = dirname(current);
			if (parent === current) throw new Error("receipt store root has no existing ancestor");
			current = parent;
		}
	}
}

function captureDirectoryIdentity(path: string, label: string): DirectoryIdentity {
	const stat = lstatSync(path);
	const canonicalPath = realpathSync(path);
	const canonicalStat = lstatSync(canonicalPath);
	if (
		stat.isSymbolicLink() ||
		!stat.isDirectory() ||
		canonicalStat.isSymbolicLink() ||
		!canonicalStat.isDirectory() ||
		realpathSync(canonicalPath) !== canonicalPath ||
		!matchesFileIdentity(identityFrom(stat), canonicalStat)
	) {
		throw new Error(`${label} is not a trusted directory`);
	}
	return { path: canonicalPath, identity: identityFrom(canonicalStat) };
}

function assertDirectoryIdentity(directory: DirectoryIdentity, label: string): void {
	const stat = lstatSync(directory.path);
	if (
		stat.isSymbolicLink() ||
		!stat.isDirectory() ||
		realpathSync(directory.path) !== directory.path ||
		!matchesFileIdentity(directory.identity, stat)
	) {
		throw new Error(`${label} changed during root durability setup`);
	}
}

function cleanupCreatedDirectories(directories: readonly DirectoryIdentity[]): unknown | undefined {
	let failure: unknown;
	for (const directory of directories) {
		let removed = false;
		try {
			assertDirectoryIdentity(directory, "new receipt store directory");
			rmdirSync(directory.path);
			removed = true;
		} catch (error) {
			if (failure === undefined) failure = error;
		}
		if (!removed) continue;
		try {
			// Persist each successful removal in its still-existing parent before moving outward.
			fsyncDirectory(dirname(directory.path));
		} catch (error) {
			if (failure === undefined) failure = error;
		}
	}
	return failure;
}

function isStrictlyUnder(root: string, path: string): boolean {
	const relativePath = relative(root, path);
	return (
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

function atomicNoOverwritePublish(tempPath: string, finalPath: string): void {
	try {
		linkSync(tempPath, finalPath);
	} catch (error) {
		throw new Error(
			`receipt store atomic no-overwrite publish failed (${errorCode(error) ?? "unknown"}); destination was not replaced`,
			{ cause: error },
		);
	}
}

/**
 * Owner-only, no-overwrite receipt persistence rooted at one trusted directory.
 * Phase A assumes same-UID path mutation is quiescent; identity checks detect observed
 * replacement but are not filesystem isolation, and persistence alone must not activate EvidenceGate.
 */
export class EvidenceReceiptStore {
	private readonly root: string;
	private readonly rootIdentity: FileIdentity;
	private readonly faultInjector: ((stage: EvidenceReceiptStoreFaultStage) => void) | undefined;

	constructor(root: string, options: EvidenceReceiptStoreOptions = {}) {
		if (typeof root !== "string" || root.length === 0) throw new Error("receipt store root must be non-empty");
		const resolvedRoot = resolve(root);
		const missingPaths = missingDirectoryPaths(resolvedRoot);
		let canonicalRoot: string;
		if (missingPaths.length === 0) {
			const stat = lstatSync(resolvedRoot);
			if (stat.isSymbolicLink()) throw new Error("receipt store root must not be a symlink");
			if (!stat.isDirectory()) throw new Error("receipt store root must be a directory");
			chmodSync(resolvedRoot, 0o700);
			canonicalRoot = realpathSync(resolvedRoot);
		} else {
			mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
			chmodSync(resolvedRoot, 0o700);
			canonicalRoot = realpathSync(resolvedRoot);
			const createdDirectories = missingPaths.map((path) =>
				captureDirectoryIdentity(path, "new receipt store directory"),
			);
			const outermostCreated = createdDirectories.at(-1);
			if (outermostCreated === undefined) throw new Error("receipt store root creation was not observed");
			try {
				// Persist each new directory before its parent, walking from the root outward.
				for (const directory of createdDirectories) {
					assertDirectoryIdentity(directory, "new receipt store directory");
					fsyncDirectory(directory.path);
					assertDirectoryIdentity(directory, "new receipt store directory");
				}
				const parent = captureDirectoryIdentity(dirname(outermostCreated.path), "receipt store root parent");
				options.faultInjector?.("before-root-parent-directory-fsync");
				assertDirectoryIdentity(parent, "receipt store root parent");
				fsyncDirectory(parent.path);
				assertDirectoryIdentity(parent, "receipt store root parent");
			} catch (error) {
				const failure = classifiedDirectoryFsyncError(dirname(outermostCreated.path), error);
				const cleanupFailure = cleanupCreatedDirectories(createdDirectories);
				if (cleanupFailure !== undefined) {
					const message = failure instanceof Error ? failure.message : String(failure);
					const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
					throw new Error(
						`receipt store root durability failed and cleanup was incomplete: ${message}; cleanup failure: ${cleanupMessage}`,
						{ cause: new AggregateError([failure, cleanupFailure], "receipt store root rollback failed") },
					);
				}
				throw failure;
			}
		}
		this.root = canonicalRoot;
		this.rootIdentity = identityFrom(lstatSync(this.root));
		this.faultInjector = options.faultInjector;
		this.assertRoot();
	}

	getRoot(): string {
		return this.root;
	}

	getReceiptPath(receiptId: string): string {
		this.assertReceiptId(receiptId);
		return join(this.root, receiptId, "receipt.json");
	}

	private assertReceiptId(receiptId: unknown): asserts receiptId is string {
		if (!isSafeEvidenceReceiptId(receiptId)) throw new Error("receiptId is not safe for storage");
	}

	private assertRoot(): void {
		const stat = lstatSync(this.root);
		if (
			stat.isSymbolicLink() ||
			!stat.isDirectory() ||
			realpathSync(this.root) !== this.root ||
			!matchesFileIdentity(this.rootIdentity, stat)
		) {
			throw new Error("receipt store root is no longer the trusted directory");
		}
	}

	private captureReceiptDirectory(receiptDirectory: string): FileIdentity {
		this.assertRoot();
		const stat = lstatSync(receiptDirectory);
		const livePath = realpathSync(receiptDirectory);
		if (
			stat.isSymbolicLink() ||
			!stat.isDirectory() ||
			livePath !== receiptDirectory ||
			!isStrictlyUnder(this.root, livePath)
		) {
			throw new Error("receipt directory is not a trusted directory");
		}
		this.assertRoot();
		return identityFrom(stat);
	}

	private assertReceiptDirectory(receiptDirectory: string, expected: FileIdentity): void {
		this.assertRoot();
		const stat = lstatSync(receiptDirectory);
		const livePath = realpathSync(receiptDirectory);
		if (
			stat.isSymbolicLink() ||
			!stat.isDirectory() ||
			livePath !== receiptDirectory ||
			!isStrictlyUnder(this.root, livePath) ||
			!matchesFileIdentity(expected, stat)
		) {
			throw new Error("receipt directory changed during persistence");
		}
		this.assertRoot();
	}

	private assertReceiptFile(
		path: string,
		receiptDirectory: string,
		directoryIdentity: FileIdentity,
		expectedFileIdentity: FileIdentity,
		label: string,
	): FileStat {
		this.assertReceiptDirectory(receiptDirectory, directoryIdentity);
		const stat = lstatSync(path);
		const livePath = realpathSync(path);
		if (
			stat.isSymbolicLink() ||
			!stat.isFile() ||
			livePath !== path ||
			dirname(livePath) !== receiptDirectory ||
			!isStrictlyUnder(this.root, livePath) ||
			!matchesFileIdentity(expectedFileIdentity, stat)
		) {
			throw new Error(`${label} path changed during persistence`);
		}
		this.assertReceiptDirectory(receiptDirectory, directoryIdentity);
		return stat;
	}

	private assertFinalAbsent(finalPath: string, receiptDirectory: string, directoryIdentity: FileIdentity): void {
		this.assertReceiptDirectory(receiptDirectory, directoryIdentity);
		try {
			lstatSync(finalPath);
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				this.assertReceiptDirectory(receiptDirectory, directoryIdentity);
				return;
			}
			throw error;
		}
		throw new Error("receipt destination already exists");
	}

	private inject(stage: EvidenceReceiptStoreFaultStage): void {
		this.faultInjector?.(stage);
	}

	private cleanupTemp(
		tempPath: string,
		receiptDirectory: string,
		directoryIdentity: FileIdentity,
		tempIdentity: FileIdentity,
	): void {
		this.assertReceiptFile(tempPath, receiptDirectory, directoryIdentity, tempIdentity, "receipt temp file");
		unlinkSync(tempPath);
		this.inject("before-temp-cleanup-directory-fsync");
		this.assertReceiptDirectory(receiptDirectory, directoryIdentity);
		fsyncDirectory(receiptDirectory);
		this.assertReceiptDirectory(receiptDirectory, directoryIdentity);
	}

	private cleanupReceiptDirectory(receiptDirectory: string, directoryIdentity: FileIdentity): void {
		this.assertReceiptDirectory(receiptDirectory, directoryIdentity);
		rmdirSync(receiptDirectory);
		this.inject("before-receipt-directory-cleanup-root-fsync");
		this.assertRoot();
		fsyncDirectory(this.root);
		this.assertRoot();
	}

	/** Persist once using hard-link publication, which cannot replace an existing destination. */
	write(receipt: EvidenceReceipt): string {
		const validated = validateEvidenceReceipt(receipt);
		const receiptId = validated.core.receiptId;
		this.assertReceiptId(receiptId);
		this.assertRoot();
		const receiptDirectory = join(this.root, receiptId);
		const finalPath = join(receiptDirectory, "receipt.json");
		const tempPath = join(receiptDirectory, `.receipt-${randomUUID()}.tmp`);
		const bytes = Buffer.from(`${serializeEvidenceReceipt(validated)}\n`, "utf8");
		let fd: number | undefined;
		let directoryIdentity: FileIdentity | undefined;
		let tempIdentity: FileIdentity | undefined;
		let tempExists = false;
		let published = false;
		let failure: unknown;
		const cleanupFailures: unknown[] = [];

		try {
			// mkdir without recursive atomically reserves this receipt ID.
			mkdirSync(receiptDirectory, { mode: 0o700 });
			directoryIdentity = this.captureReceiptDirectory(receiptDirectory);
			this.inject("after-receipt-directory");
			this.assertReceiptDirectory(receiptDirectory, directoryIdentity);

			fd = openSync(
				tempPath,
				fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
				0o600,
			);
			tempExists = true;
			tempIdentity = identityFrom(fstatSync(fd));
			this.inject("after-temp-open");
			this.assertReceiptFile(tempPath, receiptDirectory, directoryIdentity, tempIdentity, "receipt temp file");

			writeAll(fd, bytes);
			this.inject("after-temp-write");
			this.assertReceiptFile(tempPath, receiptDirectory, directoryIdentity, tempIdentity, "receipt temp file");
			fsyncSync(fd);
			this.inject("after-temp-fsync");
			this.assertReceiptFile(tempPath, receiptDirectory, directoryIdentity, tempIdentity, "receipt temp file");
			closeSync(fd);
			fd = undefined;
			this.inject("after-temp-close");
			this.assertReceiptFile(tempPath, receiptDirectory, directoryIdentity, tempIdentity, "receipt temp file");
			this.assertFinalAbsent(finalPath, receiptDirectory, directoryIdentity);
			this.inject("before-link");
			this.assertReceiptFile(tempPath, receiptDirectory, directoryIdentity, tempIdentity, "receipt temp file");

			atomicNoOverwritePublish(tempPath, finalPath);
			published = true;
			this.inject("after-link");
			this.assertReceiptFile(tempPath, receiptDirectory, directoryIdentity, tempIdentity, "receipt temp file");
			this.assertReceiptFile(finalPath, receiptDirectory, directoryIdentity, tempIdentity, "stored receipt");
			unlinkSync(tempPath);
			tempExists = false;
			this.inject("after-temp-unlink");
			this.assertReceiptFile(finalPath, receiptDirectory, directoryIdentity, tempIdentity, "stored receipt");

			fsyncDirectory(receiptDirectory);
			this.inject("after-receipt-directory-fsync");
			this.assertReceiptFile(finalPath, receiptDirectory, directoryIdentity, tempIdentity, "stored receipt");
			this.assertRoot();
			fsyncDirectory(this.root);
			this.inject("after-root-directory-fsync");
			this.assertReceiptFile(finalPath, receiptDirectory, directoryIdentity, tempIdentity, "stored receipt");
		} catch (error) {
			failure = error;
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch (error) {
					cleanupFailures.push(error);
				}
			}
		}

		if (failure !== undefined) {
			if (tempExists && directoryIdentity !== undefined && tempIdentity !== undefined) {
				try {
					this.cleanupTemp(tempPath, receiptDirectory, directoryIdentity, tempIdentity);
				} catch (error) {
					cleanupFailures.push(error);
				}
			}
			if (!published && directoryIdentity !== undefined) {
				try {
					this.cleanupReceiptDirectory(receiptDirectory, directoryIdentity);
				} catch (error) {
					cleanupFailures.push(error);
				}
			}
			if (cleanupFailures.length > 0) {
				const message = failure instanceof Error ? failure.message : String(failure);
				const cleanupMessage = cleanupFailures
					.map((cleanupFailure) =>
						cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure),
					)
					.join("; ");
				throw new Error(
					`receipt store persistence failed and cleanup was incomplete: ${message}; cleanup failure: ${cleanupMessage}`,
					{
						cause: new AggregateError([failure, ...cleanupFailures], "receipt store write rollback failed"),
					},
				);
			}
			throw failure;
		}
		return finalPath;
	}

	/** Read only bytes whose live path remains bound to the opened owner-controlled file. */
	read(receiptId: string): EvidenceReceipt {
		this.assertReceiptId(receiptId);
		this.assertRoot();
		const receiptDirectory = join(this.root, receiptId);
		const directoryIdentity = this.captureReceiptDirectory(receiptDirectory);
		const path = this.getReceiptPath(receiptId);
		const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		try {
			const before = fstatSync(fd);
			if (!before.isFile()) throw new Error("stored receipt is not a regular file");
			const fileIdentity = identityFrom(before);
			this.assertReceiptFile(path, receiptDirectory, directoryIdentity, fileIdentity, "stored receipt");
			const bytes = readFileSync(fd);
			const after = fstatSync(fd);
			this.assertReceiptFile(path, receiptDirectory, directoryIdentity, fileIdentity, "stored receipt");
			if (
				!after.isFile() ||
				!matchesFileIdentity(fileIdentity, after) ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs ||
				after.size !== bytes.byteLength
			) {
				throw new Error("stored receipt changed while it was read");
			}
			const receipt = parseEvidenceReceipt(bytes.toString("utf8"));
			if (receipt.core.receiptId !== receiptId) {
				throw new Error("stored receiptId does not match its storage key");
			}
			return receipt;
		} finally {
			closeSync(fd);
		}
	}
}
