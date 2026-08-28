import { type SpawnOptions, spawn } from "node:child_process";
import { tmpdir } from "node:os";

const SPAWN_KILL_TIMEOUT_MS = 1000;
const SOUND_ENV_KEYS = [
	"DBUS_SESSION_BUS_ADDRESS",
	"DISPLAY",
	"LANG",
	"LC_ALL",
	"PULSE_SERVER",
	"SystemRoot",
	"TEMP",
	"TMP",
	"WAYLAND_DISPLAY",
	"WINDIR",
	"XDG_RUNTIME_DIR",
] as const;

export interface CompletionSoundIo {
	/** Spawn a fixed absolute argv; resolve success/failure. */
	readonly spawnBackend: (argv: readonly string[]) => Promise<{ readonly ok: boolean; readonly diagnostic?: string }>;
	readonly writeBell: () => boolean;
}

/** Process boundary for sound backends: no inherited PATH, credentials, or workspace cwd. */
export function completionSoundProcessOptions(sourceEnv: NodeJS.ProcessEnv = process.env): SpawnOptions {
	const env: NodeJS.ProcessEnv = {};
	for (const key of SOUND_ENV_KEYS) {
		const value = sourceEnv[key];
		if (value !== undefined) env[key] = value;
	}
	return { cwd: tmpdir(), env, shell: false, stdio: "ignore", windowsHide: true };
}

/** Default IO: bounded fire-and-forget spawn with terminal BEL fallback. */
export function defaultCompletionSoundIo(): CompletionSoundIo {
	return {
		spawnBackend: (argv) =>
			new Promise((resolve) => {
				try {
					const [executable, ...args] = argv;
					const child = spawn(executable, args, completionSoundProcessOptions());
					const killTimer = setTimeout(() => {
						try {
							child.kill();
						} catch {
							// Best effort only.
						}
					}, SPAWN_KILL_TIMEOUT_MS);
					killTimer.unref();
					child.once("error", (error: NodeJS.ErrnoException) =>
						resolve({ ok: false, diagnostic: error.code ?? "spawn_error" }),
					);
					child.once("spawn", () => {
						child.unref();
						resolve({ ok: true });
					});
				} catch {
					resolve({ ok: false, diagnostic: "spawn_error" });
				}
			}),
		writeBell: () => {
			try {
				process.stdout.write("\u0007");
				return true;
			} catch {
				return false;
			}
		},
	};
}
