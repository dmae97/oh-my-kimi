/**
 * Byte-preserving remote file I/O over the shared SSH ControlMaster connection.
 *
 * Unlike `executeSSH` (which truncates/sanitizes through an OutputSink) and
 * `runSshCaptureSync` (which `.trim()`s output), these helpers move raw bytes so
 * `ssh://` reads/writes round-trip exactly — leading/trailing whitespace, tabs,
 * and final newlines are preserved.
 */
import { ptree } from "@oh-my-pi/pi-utils";
import { buildRemoteCommand, ensureConnection, type SSHConnectionTarget } from "./connection-manager";
import { quotePosixPath } from "./utils";

/** Per-operation timeout for remote transfers (matches the ssh tool's grep window). */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RemoteFileReadOptions {
	/** Maximum bytes to materialize; the helper fetches one extra byte to detect truncation. */
	maxBytes: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface RemoteFileReadResult {
	/** Raw file bytes, capped at `maxBytes`. */
	bytes: Uint8Array;
	/** True when the remote file was larger than `maxBytes` (`bytes` is the prefix). */
	truncated: boolean;
}

export interface RemoteFileWriteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Read a remote file's raw bytes. Fetches `maxBytes + 1` so the caller can
 * distinguish an exactly-`maxBytes` file from a larger (truncated) one.
 *
 * Throws `ptree.NonZeroExitError` (carrying the remote stderr tail) when the
 * file is missing/unreadable or the host is unreachable.
 */
export async function readRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: RemoteFileReadOptions,
): Promise<RemoteFileReadResult> {
	await ensureConnection(target);
	const command = `head -c ${opts.maxBytes + 1} ${quotePosixPath(remotePath)}`;
	const args = await buildRemoteCommand(target, command);
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	// Drain stdout before awaiting exit so a full pipe can't deadlock the child.
	const raw = await child.bytes();
	await child.exitedCleanly;
	const truncated = raw.length > opts.maxBytes;
	return { bytes: truncated ? raw.subarray(0, opts.maxBytes) : raw, truncated };
}

/**
 * Write `content` to a remote file byte-exact. Streams stdin into a uniquely
 * named temp file in the destination directory, then atomically renames it into
 * place so a partial transfer never clobbers the destination and concurrent
 * writers cannot collide on the temp name. The rename REPLACES a symlink at the
 * destination with a regular file rather than writing through it (resolving the
 * link target is not portable across the macOS/Linux hosts this stack supports).
 * Throws `ptree.NonZeroExitError` when the remote path is unwritable or the host
 * is unreachable.
 */
export async function writeRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	content: Uint8Array,
	opts: RemoteFileWriteOptions,
): Promise<void> {
	await ensureConnection(target);
	const dest = quotePosixPath(remotePath);
	const tmp = quotePosixPath(`${remotePath}.omp-tmp.${crypto.randomUUID()}`);
	const command = `cat > ${tmp} && mv ${tmp} ${dest}`;
	const args = await buildRemoteCommand(target, command, { allowStdin: true });
	using child = ptree.spawn(["ssh", ...args], {
		stdin: content,
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	await child.exitedCleanly;
}
