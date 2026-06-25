export function sanitizeHostName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return sanitized.length > 0 ? sanitized : "remote";
}

export function buildSshTarget(username: string | undefined, host: string): string {
	return username ? `${username}@${host}` : host;
}

/**
 * Single-quote a path for a POSIX remote shell, escaping embedded single quotes.
 * Mirrors the private `quoteRemotePath` in `tools/ssh.ts`; shared here for the
 * `ssh://` file-transfer helpers.
 */
export function quotePosixPath(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, "'\\''")}'`;
}
