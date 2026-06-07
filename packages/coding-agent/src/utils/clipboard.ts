import { execSync } from "node:child_process";
import type { ClipboardImage } from "@oh-my-pi/pi-natives";
import * as native from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

/** Env var users can set to override clipboard copy (e.g. `xclip -selection clipboard -in -silent`). */
const CUSTOM_COPY_COMMAND_ENV = "OMP_CLIPBOARD_COMMAND";

/** Timeout for any external clipboard helper. xclip / wl-copy fork after reading stdin in well under this budget. */
const COPY_TIMEOUT_MS = 5_000;

function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function isWsl(): boolean {
	return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/**
 * Linux clipboard CLI fallbacks, listed in attempt order.
 *
 * The native `arboard` backend cannot retain X11 / Wayland selection ownership after the calling
 * process exits, and for short-lived napi calls it can drop ownership before any consumer sees the
 * selection — leaving the clipboard empty even though `set_text` returned success (see #2075 on
 * QTerminal + tmux). `wl-copy` / `xclip` / `xsel` all fork after reading stdin and serve the
 * selection until another app claims it, so the payload survives.
 *
 * `requiresEnv` skips backends whose display socket is absent.
 */
interface LinuxCliBackend {
	readonly cmd: readonly string[];
	readonly requiresEnv: "WAYLAND_DISPLAY" | "DISPLAY";
}

const LINUX_CLI_BACKENDS: readonly LinuxCliBackend[] = [
	{ cmd: ["wl-copy"], requiresEnv: "WAYLAND_DISPLAY" },
	{ cmd: ["xclip", "-selection", "clipboard", "-in"], requiresEnv: "DISPLAY" },
	{ cmd: ["xsel", "--clipboard", "--input"], requiresEnv: "DISPLAY" },
];

/**
 * Spawn a clipboard CLI with `text` on stdin. Returns `true` only on a clean exit. A missing binary,
 * non-zero exit, or any spawn error is treated as a fall-through signal so the caller can try the
 * next backend.
 */
async function spawnClipboardCli(cmd: readonly string[], text: string): Promise<boolean> {
	try {
		const proc = Bun.spawn({
			cmd: cmd as string[],
			stdin: new TextEncoder().encode(text),
			stdout: "ignore",
			stderr: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), COPY_TIMEOUT_MS);
		try {
			const exitCode = await proc.exited;
			return exitCode === 0;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

async function tryCustomCommand(text: string): Promise<boolean> {
	const command = process.env[CUSTOM_COPY_COMMAND_ENV];
	if (!command) return false;
	const shell = process.platform === "win32" ? ["cmd.exe", "/c", command] : ["/bin/sh", "-c", command];
	try {
		const proc = Bun.spawn({
			cmd: shell,
			stdin: new TextEncoder().encode(text),
			stdout: "ignore",
			stderr: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), COPY_TIMEOUT_MS);
		try {
			const exitCode = await proc.exited;
			if (exitCode === 0) return true;
			logger.warn(`clipboard: ${CUSTOM_COPY_COMMAND_ENV} exited ${exitCode}`, { command });
			return false;
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		logger.warn(`clipboard: ${CUSTOM_COPY_COMMAND_ENV} failed`, { command, error: String(err) });
		return false;
	}
}

async function tryLinuxCliCopy(text: string): Promise<boolean> {
	for (const backend of LINUX_CLI_BACKENDS) {
		if (!process.env[backend.requiresEnv]) continue;
		if (await spawnClipboardCli(backend.cmd, text)) return true;
	}
	return false;
}

function emitOsc52(text: string): void {
	if (!process.stdout.isTTY) return;
	const onError = (err: unknown) => {
		process.stdout.off("error", onError);
		// Prevent unhandled 'error' from crashing the process when stdout is a closed pipe.
		if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") return;
	};
	try {
		const encoded = Buffer.from(text).toString("base64");
		const osc52 = `\x1b]52;c;${encoded}\x07`;
		process.stdout.on("error", onError);
		process.stdout.write(osc52, err => {
			process.stdout.off("error", onError);
			// OSC 52 is best-effort; swallow EPIPE on broken pipes.
			if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") return;
		});
	} catch (err) {
		process.stdout.off("error", onError);
		if ((err as NodeJS.ErrnoException | null | undefined)?.code !== "EPIPE") {
			// All write failures are ignored — OSC 52 is best-effort.
		}
	}
}

/**
 * Copy text to the system clipboard.
 *
 * Order of attempts:
 *
 * 1. **OSC 52** — emitted on a real TTY so remote terminals (SSH/mosh) that support the sequence
 *    can capture the clipboard. Harmless on terminals that don't.
 * 2. **`OMP_CLIPBOARD_COMMAND`** — user-supplied shell command receiving the text on stdin.
 *    Escape hatch for unusual setups (e.g. `xclip -selection clipboard -in -silent`).
 * 3. **Termux**: `termux-clipboard-set`.
 * 4. **Linux**: `wl-copy` / `xclip` / `xsel`. These commands daemonize so the clipboard payload
 *    survives our process exit; the native `arboard` backend cannot retain X11/Wayland selection
 *    ownership across exit and leaves the clipboard empty in QTerminal + tmux and similar
 *    short-lived CLI scenarios (#2075).
 * 5. **Native `arboard`** — required on macOS/Windows and the final fallback when no Linux CLI tool
 *    is installed. When this last step fails too, a single warning is logged so the silent-success
 *    UX from #2075 cannot recur unnoticed.
 *
 * @param text - UTF-8 text to place on the clipboard.
 */
export async function copyToClipboard(text: string): Promise<void> {
	emitOsc52(text);

	if (await tryCustomCommand(text)) return;

	if (process.env.TERMUX_VERSION) {
		try {
			execSync("termux-clipboard-set", { input: text, timeout: COPY_TIMEOUT_MS });
			return;
		} catch {
			// Fall through to native.
		}
	}

	if (process.platform === "linux" && (await tryLinuxCliCopy(text))) return;

	try {
		await native.copyToClipboard(text);
	} catch (err) {
		logger.warn(
			"clipboard: native copy failed and no CLI fallback succeeded. On Linux install xclip or wl-clipboard, or set OMP_CLIPBOARD_COMMAND.",
			{ error: String(err) },
		);
	}
}

// PowerShell one-liner that emits the clipboard image as base64-encoded PNG on
// stdout, or nothing when the clipboard does not hold image data. Used as the
// WSL bridge — arboard cannot read the Windows clipboard through WSLg.
const POWERSHELL_IMAGE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
	$ms = New-Object System.IO.MemoryStream
	$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
	[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
}
`;

const POWERSHELL_TIMEOUT_MS = 8000;

/**
 * Read a clipboard image through the Windows host's PowerShell.
 *
 * WSLg exposes a Wayland socket but no native clipboard image transport, so
 * `arboard` returns `ContentNotAvailable`. PowerShell, reached via WSL interop,
 * can read the Windows clipboard directly and round-trip the bitmap as PNG.
 *
 * Returns null when no image is on the clipboard, the host PowerShell is
 * missing, or the bridge times out.
 */
async function readImageViaPowerShell(): Promise<ClipboardImage | null> {
	try {
		const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_IMAGE_SCRIPT], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), POWERSHELL_TIMEOUT_MS);
		let stdout = "";
		try {
			stdout = await new Response(proc.stdout).text();
			await proc.exited;
		} catch (err) {
			// powershell.exe is a Windows process reached over WSL interop; if it
			// doesn't reap cleanly, swallow the error so the dispatcher can fall
			// through to the native bridge instead of throwing.
			logger.warn("clipboard: powershell read failed", { error: String(err) });
			return null;
		} finally {
			clearTimeout(timer);
		}
		if (proc.exitCode !== 0) return null;
		const b64 = stdout.trim();
		if (!b64) return null;
		const bytes = Buffer.from(b64, "base64");
		if (bytes.byteLength === 0) return null;
		return { data: bytes, mimeType: "image/png" };
	} catch {
		return null;
	}
}

/**
 * Read an image from the system clipboard.
 *
 * Returns null on Termux (no image clipboard support) or when no display
 * server is available (headless/SSH without forwarding). Under WSL the
 * Windows clipboard is reached through `powershell.exe`, since WSLg's
 * Wayland clipboard does not carry image payloads through to `arboard`.
 *
 * @returns PNG payload or null when no image is available.
 */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
	if (process.env.TERMUX_VERSION) {
		return null;
	}

	if (isWsl()) {
		const image = await readImageViaPowerShell();
		if (image) return image;
		// Fall through: arboard may still succeed on a future WSLg release —
		// but only when we actually have a display server. Headless WSL has
		// no display, so arboard would reject anyway.
	}

	if (!hasDisplay()) {
		return null;
	}

	return (await native.readImageFromClipboard()) ?? null;
}

/**
 * Read plain text from the system clipboard.
 */
export async function readTextFromClipboard(): Promise<string> {
	try {
		const p = process.platform;
		if (p === "darwin") {
			return execSync("pbpaste", { encoding: "utf8", timeout: 2000 }).toString();
		}
		if (p === "win32") {
			return execSync('powershell.exe -NoProfile -Command "Get-Clipboard"', {
				encoding: "utf8",
				timeout: 2000,
			}).toString();
		}
		if (process.env.TERMUX_VERSION) {
			return execSync("termux-clipboard-get", { encoding: "utf8", timeout: 2000 }).toString();
		}
		const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
		const hasX11Display = Boolean(process.env.DISPLAY);
		if (hasWaylandDisplay) {
			try {
				return execSync("wl-paste --type text/plain --no-newline", { encoding: "utf8", timeout: 2000 }).toString();
			} catch {
				if (hasX11Display) {
					return execSync("xclip -selection clipboard -o", { encoding: "utf8", timeout: 2000 }).toString();
				}
			}
		} else if (hasX11Display) {
			return execSync("xclip -selection clipboard -o", { encoding: "utf8", timeout: 2000 }).toString();
		}
	} catch (error) {
		logger.warn("clipboard: failed to read clipboard text", { error: String(error) });
	}
	return "";
}
