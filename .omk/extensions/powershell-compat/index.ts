/**
 * Windows PowerShell compatibility for OMK's bash tool.
 *
 * `getShellConfig` requires a POSIX shell: on Windows it looks for Git Bash,
 * then any `bash.exe` on PATH, and throws with install instructions when it
 * finds neither. A machine with only PowerShell therefore cannot run the bash
 * tool at all.
 *
 * This registers a bash tool whose execution backend is PowerShell, gated by
 * the decision table in `translate.ts`: external programs pass through, a small
 * audited set of builtins is rewritten, and anything that PowerShell would
 * misinterpret is refused with the reason. It never guesses at a destructive
 * command.
 *
 * The extension is inert unless it is actually needed — on a host with a
 * working POSIX shell it registers nothing, so behaviour on Linux and macOS is
 * unchanged and Windows users with Git Bash keep the real bash.
 *
 * Install: copy this directory to `~/.omk/agent/extensions/powershell-compat/`
 * or `.omk/extensions/powershell-compat/`.
 */

import { spawn, spawnSync } from "node:child_process";
import { createBashTool, type ExtensionAPI } from "open-multi-agent-kit";
import { decidePowerShellCommand, type PowerShellHost } from "./translate.ts";

/** Resolve the PowerShell host, preferring cross-platform `pwsh` (7+). */
export function detectPowerShell(): { readonly exe: string; readonly host: PowerShellHost } | undefined {
	for (const exe of ["pwsh", "powershell"]) {
		const probe = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
			encoding: "utf8",
			timeout: 10_000,
		});
		if (probe.status !== 0) continue;
		const major = Number.parseInt(probe.stdout.trim(), 10);
		if (Number.isFinite(major)) return { exe, host: { major } };
	}
	return undefined;
}

/** True when OMK's own shell resolution would succeed, in which case we stay out of the way. */
function posixShellAvailable(): boolean {
	if (process.platform !== "win32") return true;
	const probe = spawnSync("bash", ["-c", "exit 0"], { timeout: 10_000 });
	return probe.status === 0;
}

export default function (omk: ExtensionAPI) {
	if (posixShellAvailable()) return;

	const detected = detectPowerShell();
	if (!detected) return;
	const { exe, host } = detected;

	const bashTool = createBashTool(process.cwd(), {
		operations: {
			exec: (command, cwd, { onData, signal, timeout, env }) => {
				const decision = decidePowerShellCommand(command, host);

				if (decision.kind === "refuse") {
					// Surface this as command output with a non-zero exit rather
					// than throwing: the agent reads it, sees why, and can retry
					// with the PowerShell form. A thrown error reads like a tool
					// malfunction instead of a rejected command.
					onData(
						Buffer.from(
							`powershell-compat: refused this command.\n${decision.reason}\n\n` +
								`Host: ${exe} ${host.major}.x. Write the PowerShell form explicitly, ` +
								`or install Git for Windows so OMK can use real bash.\n`,
						),
					);
					return Promise.resolve({ exitCode: 1 });
				}

				if (decision.kind === "rewrite") {
					onData(Buffer.from(`powershell-compat: ${decision.note}\n`));
				}

				return runPowerShell(exe, decision.command, cwd, { onData, signal, timeout, env });
			},
		},
	});

	omk.registerTool(bashTool);
}

function runPowerShell(
	exe: string,
	command: string,
	cwd: string,
	options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		env?: NodeJS.ProcessEnv;
	},
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve) => {
		// -NoProfile keeps a user's profile from changing behaviour between
		// runs; -NonInteractive stops a prompt from hanging the tool forever.
		const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", command], {
			cwd,
			env: options.env ?? process.env,
		});

		const timer =
			options.timeout === undefined ? undefined : setTimeout(() => child.kill("SIGTERM"), options.timeout);
		const onAbort = () => child.kill("SIGTERM");
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", options.onData);
		child.stderr.on("data", options.onData);

		const finish = (exitCode: number | null) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode });
		};

		child.on("error", (error) => {
			options.onData(Buffer.from(`powershell-compat: failed to start ${exe}: ${error.message}\n`));
			finish(1);
		});
		child.on("close", finish);
	});
}
