import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { $which, logger } from "@oh-my-pi/pi-utils";

const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function getExistingWslLocalPath(urlOrPath: string): string | undefined {
	if (
		process.platform !== "linux" ||
		!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) ||
		!$which("wslview")
	) {
		return undefined;
	}

	try {
		const localPath = urlOrPath.startsWith("file://")
			? url.fileURLToPath(urlOrPath)
			: URL_SCHEME_PATTERN.test(urlOrPath)
				? undefined
				: path.resolve(urlOrPath);
		if (!localPath || !fs.existsSync(localPath)) return undefined;

		const result = Bun.spawnSync(["wslpath", "-w", localPath], { stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) return undefined;

		return result.stdout.toString().trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the Windows `rundll32.exe` command used to hand a URL/path to the
 * user's registered protocol handler. Anchoring to `%SystemRoot%\System32`
 * (rather than relying on `rundll32` being on `PATH`) survives environments
 * where the machine `PATH` no longer references `System32` — a common
 * real-world misconfiguration where `System32\Wbem` / `WindowsPowerShell` /
 * `OpenSSH` survive but `System32` itself is dropped. Bare `rundll32` on
 * such boxes throws `Executable not found in $PATH: "rundll32"` from
 * `Bun.spawn` before ShellExecute ever sees the URL.
 */
function windowsOpenerCommand(target: string): string[] {
	const systemRoot = process.env.SystemRoot?.trim() || process.env.SYSTEMROOT?.trim() || "C:\\Windows";
	// `path.win32` (not the platform-adaptive `path.join`) keeps Windows path
	// separators when tests run under a POSIX host and matches Windows call
	// conventions on the real target.
	const rundll32 = path.win32.join(systemRoot, "System32", "rundll32.exe");
	return [rundll32, "url.dll,FileProtocolHandler", target];
}
/** Open a URL or file path in the default browser/application. Best-effort, never throws. */
export function openPath(urlOrPath: string): void {
	let cmd: string[];
	switch (process.platform) {
		case "darwin":
			cmd = ["open", urlOrPath];
			break;
		case "win32":
			cmd = windowsOpenerCommand(urlOrPath);
			break;
		default: {
			const wslPath = getExistingWslLocalPath(urlOrPath);
			cmd = wslPath ? ["wslview", wslPath] : ["xdg-open", urlOrPath];
			break;
		}
	}
	let child: Bun.Subprocess | undefined;
	try {
		child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	} catch (error) {
		// Spawn threw synchronously (missing binary, denied exec, sandbox
		// restriction, …). Best-effort: log so the failure isn't invisible while
		// still letting the caller advertise a copy-URL fallback.
		logger.warn("Failed to open external URL/path", {
			command: cmd[0],
			target: urlOrPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	// Detect delayed failures (exec succeeded but the opener exited non-zero)
	// without blocking the caller. Recording them makes silent misconfigurations
	// (e.g. `xdg-open` present but no MIME handler for `https`) diagnosable from
	// `~/.omp/logs/omp.*.log`.
	child.exited.then(
		exitCode => {
			if (typeof exitCode === "number" && exitCode !== 0) {
				logger.warn("External opener exited with non-zero status", {
					command: cmd[0],
					target: urlOrPath,
					exitCode,
				});
			}
		},
		() => {
			// Ignore — awaiting the subprocess is best-effort telemetry.
		},
	);
}
