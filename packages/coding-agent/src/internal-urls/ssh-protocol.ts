/**
 * Protocol handler for `ssh://host/path` URLs.
 *
 * Resolves a single remote text file on a pre-configured SSH host — or any
 * destination OpenSSH can resolve itself (e.g. a `~/.ssh/config` alias) — for
 * the read, search, and write tools, reusing the shared ControlMaster
 * connection in `../ssh/connection-manager`.
 *
 * Text only. Binary/non-UTF-8 files and files larger than 1 MiB are rejected
 * with an explicit error rather than returned as a resource: this handler
 * exposes no `sourcePath`, so a note-style resource would make `search` grep the
 * note text and report "No matches found", hiding the real condition.
 *
 * `loadCapability` is imported from `../capability` (not the `../discovery`
 * barrel) on purpose — pulling the barrel here would route
 * `path-utils -> internal-urls -> ssh-protocol -> discovery -> path-utils` and
 * eager-load every provider on any `path-utils` import. Runtime bootstraps the
 * SSH provider via `import "./discovery"` (sdk.ts) / `initializeWithSettings`
 * (main.ts) before any tool resolves.
 */
import * as capability from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";
import type { SSHConnectionTarget } from "../ssh/connection-manager";
import { readRemoteFile, writeRemoteFile } from "../ssh/file-transfer";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, WriteContext } from "./types";

/** Largest remote text file `ssh://` will materialize (mirrors the local:// cap). */
const SSH_TEXT_MAX_BYTES = 1024 * 1024;

/** POSIX-aware content type from the last path segment's extension. */
function contentTypeFor(remotePath: string): InternalResource["contentType"] {
	const slash = remotePath.lastIndexOf("/");
	const base = slash === -1 ? remotePath : remotePath.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	const ext = dot <= 0 ? "" : base.slice(dot).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

/** Decode the whole buffer as UTF-8 text, or null if it holds a NUL or invalid byte. */
function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (bytes.indexOf(0) !== -1) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * Remote absolute path from the URL. Uses `rawPathname` (pre-normalization) so
 * `..`/`//` and percent-escapes survive verbatim to the remote shell; the
 * authority (host/user/port) stays on the WHATWG fields, which preserve case for
 * the non-special `ssh` scheme.
 */
function remotePathFromUrl(url: InternalUrl): string {
	const raw = url.rawPathname ?? url.pathname;
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new Error(`Invalid URL encoding in ssh:// path: ${url.href}`);
	}
	if (!decoded || decoded === "/") {
		throw new Error("ssh:// requires an absolute file path, e.g. ssh://host/etc/hosts");
	}
	return decoded;
}

/**
 * Resolve the URL authority to an SSH connection target. Prefers an
 * OMP-discovered host by name; otherwise treats the authority as an opaque
 * OpenSSH destination so plain `~/.ssh/config` aliases work. User/port overrides
 * on a configured host name are rejected — the ControlMaster/host-info caches
 * key on `name` alone, so a different authority under the same alias would
 * collide.
 */
async function resolveTarget(url: InternalUrl, cwd?: string): Promise<SSHConnectionTarget> {
	const host = url.hostname;
	if (!host) {
		throw new Error("ssh:// requires a host: ssh://<host>/<absolute-path>");
	}
	const username = url.username || undefined;
	const port = url.port ? Number(url.port) : undefined;

	const { items } = await capability.loadCapability<SSHHost>(sshCapability.id, { cwd });
	const match = items.find(entry => entry.name === host);

	if (match) {
		if (username || port !== undefined) {
			throw new Error(
				`ssh://: user/port overrides are not allowed for the configured host "${host}"; use ssh://${host}/<path> or an unconfigured hostname`,
			);
		}
		return {
			name: match.name,
			host: match.host,
			username: match.username,
			port: match.port,
			keyPath: match.keyPath,
			compat: match.compat,
		};
	}

	const name = `${username ? `${username}@` : ""}${host}${port !== undefined ? `:${port}` : ""}`;
	return { name, host, username, port };
}

export class SshProtocolHandler implements ProtocolHandler {
	readonly scheme = "ssh";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const target = await resolveTarget(url, context?.cwd);
		const remotePath = remotePathFromUrl(url);
		const { bytes, truncated } = await readRemoteFile(target, remotePath, {
			maxBytes: SSH_TEXT_MAX_BYTES,
			signal: context?.signal,
		});
		if (truncated) {
			throw new Error(
				`ssh://: ${remotePath} exceeds the 1 MiB limit; ssh:// supports text files up to 1 MiB — use an sshfs mount for larger files`,
			);
		}
		const content = decodeUtf8Text(bytes);
		if (content === null) {
			throw new Error(
				`ssh://: ${remotePath} is a binary or non-UTF-8 file; ssh:// supports UTF-8 text only — use the ssh tool or an sshfs mount`,
			);
		}
		// No `sourcePath`: keeps search on the virtual-resource path so the
		// displayed/searched resource stays `ssh://…` instead of a temp path.
		return {
			url: url.href,
			content,
			contentType: contentTypeFor(remotePath),
			size: bytes.length,
		};
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const target = await resolveTarget(url, context?.cwd);
		const remotePath = remotePathFromUrl(url);
		await writeRemoteFile(target, remotePath, new TextEncoder().encode(content), { signal: context?.signal });
	}
}
