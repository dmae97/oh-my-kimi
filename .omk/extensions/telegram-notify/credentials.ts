/**
 * Credential file loading for the Telegram notifier.
 *
 * The extension is configured by environment variables, which is right for a
 * server and wrong for a laptop: an interactive `omk` inherits whatever the
 * shell happened to export, so a token lives in a shell rc, which is read by
 * every process the user ever starts.
 *
 * A file the owner controls is the narrower place. It lives outside the
 * repository — a bot token in a committed config is a token in everyone's
 * checkout — and it is owner-readable only, so the credential is scoped to one
 * account instead of one machine.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default credential file. Outside the repository, in the owner's agent home. */
export function defaultCredentialPath(env: Record<string, string | undefined>): string {
	const override = env.OMK_TELEGRAM_ENV_FILE?.trim();
	return override || join(homedir(), ".omk", "telegram.env");
}

/** `KEY=VALUE`, `#` comments, blank lines. Not a shell: no expansion, no export. */
export function parseEnvFile(source: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of source.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const separator = line.indexOf("=");
		if (separator <= 0) continue;

		const key = line.slice(0, separator).trim();
		// A key that is not a plain identifier is a malformed line, not a
		// variable. Skipping it keeps a typo from becoming a strange env entry.
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

		values[key] = unquote(line.slice(separator + 1).trim());
	}
	return values;
}

function unquote(value: string): string {
	const quoted = value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0] ?? "");
	return quoted ? value.slice(1, -1) : value;
}

/**
 * Whether the file is readable by anyone but its owner.
 *
 * A group- or world-readable token is shared with every account on the box, so
 * the caller reports it. It is not treated as fatal: refusing to notify is not
 * a security win, and the owner may have deliberately loosened a mode.
 */
export function isPermissive(mode: number): boolean {
	return (mode & 0o077) !== 0;
}

export interface LoadedCredentials {
	readonly values: Record<string, string>;
	/** Set when the file was read but is readable beyond its owner. */
	readonly permissiveMode?: number;
}

/**
 * Read the credential file, or return nothing.
 *
 * Absence is the normal case for anyone who has not set this up, and an
 * unreadable or malformed file must not fail the run that triggered the read.
 */
export function loadCredentialFile(path: string): LoadedCredentials {
	let source: string;
	let mode: number;
	try {
		source = readFileSync(path, "utf8");
		mode = statSync(path).mode;
	} catch {
		return { values: {} };
	}

	const values = parseEnvFile(source);
	return isPermissive(mode) ? { values, permissiveMode: mode & 0o777 } : { values };
}

/**
 * Merge file values under the process environment.
 *
 * The environment wins. An explicit `TELEGRAM_CHAT_ID=...` in front of a command
 * is the more specific instruction, and a file that could override it would make
 * a one-off redirect silently go to the stored chat.
 */
export function withCredentialFile(
	env: Record<string, string | undefined>,
	load: (path: string) => LoadedCredentials = loadCredentialFile,
): { readonly env: Record<string, string | undefined>; readonly permissiveMode?: number } {
	const loaded = load(defaultCredentialPath(env));
	if (Object.keys(loaded.values).length === 0) return { env };
	return { env: { ...loaded.values, ...env }, permissiveMode: loaded.permissiveMode };
}
