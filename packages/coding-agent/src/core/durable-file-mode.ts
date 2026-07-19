import { closeSync, fchmodSync, fstatSync, openSync } from "fs";

const PRIVATE_FILE_MODE = 0o600;

export class DurableFileModeError extends Error {
	override readonly name = "DurableFileModeError";
	readonly path: string;

	constructor(path: string, cause: unknown) {
		const code = cause instanceof Error && "code" in cause ? String(Reflect.get(cause, "code")) : undefined;
		super(`Cannot enforce private mode 0600 for ${path} on ${process.platform}${code ? ` (${code})` : ""}`, {
			cause,
		});
		this.path = path;
	}
}

export function enforcePrivateFileDescriptorModeSync(fd: number, path: string): void {
	if (process.platform === "win32") return;
	try {
		const current = fstatSync(fd).mode & 0o7777;
		if (current === PRIVATE_FILE_MODE) return;
		fchmodSync(fd, PRIVATE_FILE_MODE);
		const actual = fstatSync(fd).mode & 0o7777;
		if (actual !== PRIVATE_FILE_MODE) throw new Error(`mode remained ${actual.toString(8)}`);
	} catch (error) {
		throw new DurableFileModeError(path, error);
	}
}

export function enforcePrivateFileModeSync(path: string): void {
	if (process.platform === "win32") return;
	const fd = openSync(path, "r");
	try {
		enforcePrivateFileDescriptorModeSync(fd, path);
	} finally {
		closeSync(fd);
	}
}
