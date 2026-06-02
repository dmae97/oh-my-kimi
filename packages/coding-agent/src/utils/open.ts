import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as piUtils from "@oh-my-pi/pi-utils";

const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function getExistingWslLocalPath(urlOrPath: string): string | undefined {
	if (
		process.platform !== "linux" ||
		!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) ||
		!piUtils.$which("wslview")
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

/** Open a URL or file path in the default browser/application. Best-effort, never throws. */
export function openPath(urlOrPath: string): void {
	let cmd: string[];
	switch (process.platform) {
		case "darwin":
			cmd = ["open", urlOrPath];
			break;
		case "win32":
			cmd = ["rundll32", "url.dll,FileProtocolHandler", urlOrPath];
			break;
		default: {
			const wslPath = getExistingWslLocalPath(urlOrPath);
			cmd = wslPath ? ["wslview", wslPath] : ["xdg-open", urlOrPath];
			break;
		}
	}
	try {
		Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	} catch {
		// Best-effort: browser opening is non-critical
	}
}
