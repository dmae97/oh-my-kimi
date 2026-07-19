import { randomBytes } from "crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "fs";
import { basename, dirname, join } from "path";
import { enforcePrivateFileDescriptorModeSync } from "./durable-file-mode.ts";

function assertRewriteTargetSafe(path: string): void {
	try {
		if (statSync(path).nlink > 1) throw new Error("Atomic rewrite refused for a target with more than one hard link");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || Reflect.get(error, "code") !== "ENOENT") throw error;
	}
}

/**
 * Atomically and durably replace the contents of `targetPath`.
 *
 * Writes a uniquely named temp file in the same directory, preserves the
 * exact private mode 0600, fsyncs and closes the temp file, then renames it
 * over the target so readers only ever observe the complete old or
 * complete new content, never a truncated file. The parent directory is
 * fsynced where supported. Windows and explicit unsupported-filesystem codes
 * skip that final operation; real durability failures propagate. On any failure
 * before the rename completes, the temp file is
 * removed (best-effort) and the original target is left untouched.
 */
export function atomicRewriteFileSync(targetPath: string, data: string | Uint8Array): void {
	let rewritePath: string;
	try {
		rewritePath = realpathSync.native(targetPath);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? Reflect.get(error, "code") : undefined;
		if (code !== "ENOENT") throw error;
		let danglingLink = false;
		try {
			danglingLink = lstatSync(targetPath).isSymbolicLink();
		} catch (lstatError) {
			const lstatCode =
				lstatError instanceof Error && "code" in lstatError ? Reflect.get(lstatError, "code") : undefined;
			if (lstatCode !== "ENOENT") throw lstatError;
		}
		if (danglingLink) throw error;
		rewritePath = targetPath;
	}
	const dir = dirname(rewritePath);

	assertRewriteTargetSafe(rewritePath);
	const tempPath = join(dir, `.${basename(rewritePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, "wx", 0o600);
		enforcePrivateFileDescriptorModeSync(fd, rewritePath);
		const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
		let offset = 0;
		while (offset < buffer.length) {
			offset += writeSync(fd, buffer, offset);
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		assertRewriteTargetSafe(rewritePath);
		renameSync(tempPath, rewritePath);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch (cleanupError) {
				if (!(cleanupError instanceof Error)) throw cleanupError;
			}
		}
		try {
			unlinkSync(tempPath);
		} catch (cleanupError) {
			if (!(cleanupError instanceof Error)) throw cleanupError;
		}
		throw error;
	}

	if (process.platform === "win32") return;
	try {
		const dirFd = openSync(dir, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch (error) {
		const code = error instanceof Error && "code" in error ? Reflect.get(error, "code") : undefined;
		if (typeof code !== "string" || !new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]).has(code)) {
			throw error;
		}
	}
}
