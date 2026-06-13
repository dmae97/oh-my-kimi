import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getSessionsDir, getTerminalSessionsDir, isEnoent, logger, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "./session-storage";

const migratedSessionRoots = new Set<string>();

/**
 * Merge or rename a legacy session directory into its canonical target.
 * Best effort: callers decide whether migration failures should surface.
 */
function migrateSessionDirPath(oldPath: string, newPath: string): void {
	const existing = fs.statSync(newPath, { throwIfNoEntry: false });
	if (existing?.isDirectory()) {
		for (const file of fs.readdirSync(oldPath)) {
			const src = path.join(oldPath, file);
			const dst = path.join(newPath, file);
			if (!fs.existsSync(dst)) {
				fs.renameSync(src, dst);
			}
		}
		fs.rmSync(oldPath, { recursive: true, force: true });
		return;
	}
	if (existing) {
		fs.rmSync(newPath, { recursive: true, force: true });
	}
	fs.renameSync(oldPath, newPath);
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
	const encoded = relative.replace(/[/\\:]/g, "-");
	return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

function getDefaultSessionDirName(cwd: string): { encodedDirName: string; resolvedCwd: string } {
	const resolvedCwd = path.resolve(cwd);
	const canonicalCwd = resolveEquivalentPath(resolvedCwd);
	const home = os.homedir();
	const canonicalHome = resolveEquivalentPath(home);
	const tempRoot = os.tmpdir();
	const canonicalTempRoot = resolveEquivalentPath(tempRoot);
	const homeRelative = path.relative(canonicalHome, canonicalCwd);
	const tempRelative = path.relative(canonicalTempRoot, canonicalCwd);
	const encodedDirName =
		homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))
			? encodeRelativeSessionDirName("-", homeRelative)
			: tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative))
				? encodeRelativeSessionDirName("-tmp", tempRelative)
				: encodeLegacyAbsoluteSessionDirName(canonicalCwd);
	return { encodedDirName, resolvedCwd };
}

/**
 * Migrate old `--<home-encoded>-*--` session dirs to the new `-*` format.
 * Runs once per sessions root on first access, best-effort.
 */
function migrateHomeSessionDirs(sessionsRoot: string): void {
	if (migratedSessionRoots.has(sessionsRoot)) return;
	migratedSessionRoots.add(sessionsRoot);

	const home = os.homedir();
	const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const oldPrefix = `--${homeEncoded}-`;
	const oldExact = `--${homeEncoded}--`;

	let entries: string[];
	try {
		entries = fs.readdirSync(sessionsRoot);
	} catch {
		return;
	}

	for (const entry of entries) {
		let remainder: string;
		if (entry === oldExact) {
			remainder = "";
		} else if (entry.startsWith(oldPrefix) && entry.endsWith("--")) {
			remainder = entry.slice(oldPrefix.length, -2);
		} else {
			continue;
		}

		const newName = remainder ? `-${remainder}` : "-";
		const oldPath = path.join(sessionsRoot, entry);
		const newPath = path.join(sessionsRoot, newName);

		try {
			migrateSessionDirPath(oldPath, newPath);
		} catch {
			// Best effort
		}
	}
}

function migrateLegacyAbsoluteSessionDir(cwd: string, sessionDir: string, sessionsRoot: string): void {
	const legacyDir = path.join(sessionsRoot, encodeLegacyAbsoluteSessionDirName(cwd));
	if (legacyDir === sessionDir || !fs.existsSync(legacyDir)) return;

	try {
		migrateSessionDirPath(legacyDir, sessionDir);
	} catch {
		// Best effort
	}
}

export function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined {
	const currentDirName = path.basename(sessionDir);
	const { encodedDirName } = getDefaultSessionDirName(cwd);
	if (currentDirName !== encodedDirName && currentDirName !== encodeLegacyAbsoluteSessionDirName(cwd)) {
		return undefined;
	}
	return path.dirname(sessionDir);
}

/**
 * Compute the default session directory for a cwd.
 * Classifies cwd by canonical location so symlink/alias paths resolve to the
 * same home-relative or temp-root directory names as their real targets.
 */
export function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	const { encodedDirName, resolvedCwd } = getDefaultSessionDirName(cwd);
	migrateHomeSessionDirs(sessionsRoot);
	const sessionDir = path.join(sessionsRoot, encodedDirName);
	migrateLegacyAbsoluteSessionDir(resolvedCwd, sessionDir, sessionsRoot);
	storage.ensureDirSync(sessionDir);
	return sessionDir;
}

// =============================================================================
// Terminal breadcrumbs: maps terminal (TTY) -> last session file for --continue
// =============================================================================

/**
 * Write a breadcrumb linking the current terminal to a session file.
 * The breadcrumb contains the cwd and session path so --continue can
 * find "this terminal's last session" even when running concurrent instances.
 */
export function writeTerminalBreadcrumb(cwd: string, sessionFile: string): void {
	const terminalId = getTerminalId();
	if (!terminalId) return;

	const breadcrumbDir = getTerminalSessionsDir();
	const breadcrumbFile = path.join(breadcrumbDir, terminalId);
	const content = `${cwd}\n${sessionFile}\n`;
	// Best-effort — don't break session creation if breadcrumb fails
	Bun.write(breadcrumbFile, content).catch(() => {});
}

export interface TerminalBreadcrumb {
	cwd: string;
	sessionFile: string;
}

/**
 * Read the raw terminal breadcrumb for the current terminal.
 * Returns the recorded cwd + session file (verified to exist) regardless of
 * whether the recorded cwd still matches the current one. Callers decide how
 * to interpret a cwd mismatch (e.g. a moved/renamed worktree).
 */
export async function readTerminalBreadcrumbEntry(): Promise<TerminalBreadcrumb | null> {
	const terminalId = getTerminalId();
	if (!terminalId) return null;

	try {
		const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
		const content = await Bun.file(breadcrumbFile).text();
		const lines = content.trim().split("\n");
		if (lines.length < 2) return null;

		const breadcrumbCwd = lines[0];
		const sessionFile = lines[1];

		// Verify the session file still exists
		const stat = fs.statSync(sessionFile, { throwIfNoEntry: false });
		if (stat?.isFile()) return { cwd: breadcrumbCwd, sessionFile };
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		// Breadcrumb doesn't exist or is corrupt — fall through
	}
	return null;
}
