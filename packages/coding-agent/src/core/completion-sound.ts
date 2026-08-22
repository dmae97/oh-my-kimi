import { spawn } from "node:child_process";
import type { PromptSettledEvent } from "./prompt-settlement.ts";

/**
 * Cross-platform completion sound service (OMK v0.97.x roadmap §17, M4/PR7).
 *
 * Consumes `prompt_settled` only (§16.1: never `agent_end`) and is a pure UX
 * signal — it must never influence run outcome, block the event loop, or
 * delay process exit (§17.4: spawn with `stdio: "ignore"`, `shell: false`,
 * `unref()`, bounded kill timer, never awaited by the prompt path).
 *
 * Security (§22.1): every backend uses a fixed executable and fixed argv;
 * no user text, paths, or model output is ever interpolated.
 *
 * Backend selection is a deterministic candidate chain per platform
 * (§17.3); a spawn failure falls through to the next candidate and finally
 * to the terminal BEL. All failures are diagnostics only (§4.6).
 */

export interface CompletionSoundSettings {
	enabled?: boolean; // default: false (§17.1: backward compat, CI/headless surprise, accessibility)
	minDurationMs?: number; // default: 5000
	onSuccess?: boolean; // default: true
	onFailure?: boolean; // default: true
	terminalBellFallback?: boolean; // default: true
}

export interface NotificationSettings {
	completionSound?: CompletionSoundSettings;
}

export type CompletionSoundBackend =
	| "macos-afplay"
	| "windows-system-sound"
	| "linux-canberra"
	| "linux-paplay"
	| "linux-aplay"
	| "terminal-bell"
	| "none";

export interface CompletionSoundRequest {
	readonly promptRunId: string;
	readonly outcome: "completed" | "failed" | "aborted";
	readonly durationMs: number;
}

export interface CompletionSoundResult {
	readonly backend: CompletionSoundBackend;
	readonly attempted: boolean;
	readonly success: boolean;
	readonly diagnostic?: string;
}

export const COMPLETION_SOUND_ENV = "OMK_COMPLETION_SOUND";
const SPAWN_KILL_TIMEOUT_MS = 1000;

export interface ResolvedCompletionSoundSettings {
	readonly enabled: boolean;
	readonly minDurationMs: number;
	readonly onSuccess: boolean;
	readonly onFailure: boolean;
	readonly terminalBellFallback: boolean;
}

/** Defaults per §17.1; `OMK_COMPLETION_SOUND=0|1` (§18.2) overrides `enabled`. */
export function resolveCompletionSoundSettings(
	settings?: CompletionSoundSettings,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedCompletionSoundSettings {
	let enabled = settings?.enabled ?? false;
	const envValue = env[COMPLETION_SOUND_ENV]?.trim();
	if (envValue === "0") {
		enabled = false;
	} else if (envValue === "1") {
		enabled = true;
	}
	return {
		enabled,
		minDurationMs:
			typeof settings?.minDurationMs === "number" && settings.minDurationMs >= 0 ? settings.minDurationMs : 5000,
		onSuccess: settings?.onSuccess ?? true,
		onFailure: settings?.onFailure ?? true,
		terminalBellFallback: settings?.terminalBellFallback ?? true,
	};
}

export interface CompletionSoundSurface {
	/** Only the interactive TUI plays sounds by default (§17.4). */
	readonly isTui: boolean;
	readonly isTty: boolean;
	readonly isCi: boolean;
}

/** §17.1/§17.4 gate: settings, outcome mapping, duration floor, and surface. */
export function shouldPlayCompletionSound(input: {
	readonly settings: ResolvedCompletionSoundSettings;
	readonly event: PromptSettledEvent;
	readonly surface: CompletionSoundSurface;
}): boolean {
	const { settings, event, surface } = input;
	if (!settings.enabled || !surface.isTui || !surface.isTty || surface.isCi) {
		return false;
	}
	if (event.durationMs < settings.minDurationMs) {
		return false;
	}
	if (event.outcome === "completed") {
		return settings.onSuccess;
	}
	if (event.outcome === "failed") {
		return settings.onFailure;
	}
	// User-initiated aborts never chime: the user is already at the keyboard.
	return false;
}

export interface CompletionSoundCandidate {
	readonly backend: CompletionSoundBackend;
	/** Fixed argv (§22.1); empty for terminal-bell (written, not spawned). */
	readonly argv: readonly string[];
}

/**
 * Deterministic backend candidate chain per platform (§17.3, §23.2 property
 * 14). The runner tries candidates in order on spawn failure.
 */
export function selectCompletionSoundCandidates(input: {
	readonly platform: NodeJS.Platform;
	readonly isWsl: boolean;
	readonly terminalBellFallback: boolean;
}): readonly CompletionSoundCandidate[] {
	const bell: CompletionSoundCandidate[] = input.terminalBellFallback ? [{ backend: "terminal-bell", argv: [] }] : [];
	if (input.platform === "darwin") {
		return [{ backend: "macos-afplay", argv: ["afplay", "/System/Library/Sounds/Glass.aiff"] }, ...bell];
	}
	if (input.platform === "win32") {
		return [{ backend: "windows-system-sound", argv: windowsSystemSoundArgv("powershell.exe") }, ...bell];
	}
	if (input.platform === "linux" && input.isWsl) {
		// §17.3 WSL: Windows PowerShell first, then the terminal BEL.
		return [{ backend: "windows-system-sound", argv: windowsSystemSoundArgv("powershell.exe") }, ...bell];
	}
	if (input.platform === "linux") {
		return [
			{ backend: "linux-canberra", argv: ["canberra-gtk-play", "-i", "complete"] },
			{ backend: "linux-paplay", argv: ["paplay", "/usr/share/sounds/freedesktop/stereo/complete.oga"] },
			{ backend: "linux-aplay", argv: ["aplay", "-q", "/usr/share/sounds/alsa/Front_Center.wav"] },
			...bell,
		];
	}
	return [...bell];
}

/** Fixed expression only (§17.3 Windows): no user text ever enters the command. */
function windowsSystemSoundArgv(executable: string): readonly string[] {
	return [executable, "-NoProfile", "-NonInteractive", "-Command", "[System.Media.SystemSounds]::Asterisk.Play()"];
}

export interface CompletionSoundIo {
	/** Spawn a fixed argv; resolve success/failure. Must never throw synchronously into the caller. */
	readonly spawnBackend: (argv: readonly string[]) => Promise<{ readonly ok: boolean; readonly diagnostic?: string }>;
	readonly writeBell: () => boolean;
}

/** Default IO: detached-ish fire-and-forget spawn per §17.4. */
export function defaultCompletionSoundIo(): CompletionSoundIo {
	return {
		spawnBackend: (argv) =>
			new Promise((resolve) => {
				try {
					const [executable, ...args] = argv;
					const child = spawn(executable, args, { stdio: "ignore", shell: false, windowsHide: true });
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
					// Success means "spawned"; playback is not awaited (§17.4).
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

/**
 * Stateful service: once per promptRunId (§17.4), deterministic candidate
 * walk, all failures downgraded to diagnostics. `handleSettled` is fire and
 * forget — callers must not await it on the prompt path.
 */
export interface CompletionSoundServiceDeps {
	readonly getSettings: () => CompletionSoundSettings | undefined;
	readonly surface: () => CompletionSoundSurface;
	readonly candidates: () => readonly CompletionSoundCandidate[];
	readonly io?: CompletionSoundIo;
	readonly env?: NodeJS.ProcessEnv;
	/** §20.2 observability hook; fail-open, never affects the result. */
	readonly onResult?: (result: CompletionSoundResult) => void;
}

export class CompletionSoundService {
	private readonly playedRunIds = new Set<string>();
	private lastResult: CompletionSoundResult | null = null;
	private readonly deps: CompletionSoundServiceDeps;

	constructor(deps: CompletionSoundServiceDeps) {
		this.deps = deps;
	}

	/** Most recent attempt, for diagnostics/tests. */
	get lastPlaybackResult(): CompletionSoundResult | null {
		return this.lastResult;
	}

	async handleSettled(event: PromptSettledEvent): Promise<CompletionSoundResult> {
		try {
			const settings = resolveCompletionSoundSettings(this.deps.getSettings(), this.deps.env ?? process.env);
			if (this.playedRunIds.has(event.promptRunId)) {
				return this.finish({ backend: "none", attempted: false, success: false, diagnostic: "already_played" });
			}
			if (!shouldPlayCompletionSound({ settings, event, surface: this.deps.surface() })) {
				return this.finish({ backend: "none", attempted: false, success: true });
			}
			this.playedRunIds.add(event.promptRunId);
			const io = this.deps.io ?? defaultCompletionSoundIo();
			const diagnostics: string[] = [];
			for (const candidate of this.deps.candidates()) {
				if (candidate.backend === "terminal-bell") {
					const ok = io.writeBell();
					return this.finish({
						backend: "terminal-bell",
						attempted: true,
						success: ok,
						diagnostic: diagnostics.length > 0 ? diagnostics.join(", ") : undefined,
					});
				}
				const spawned = await io.spawnBackend(candidate.argv);
				if (spawned.ok) {
					return this.finish({ backend: candidate.backend, attempted: true, success: true });
				}
				diagnostics.push(`${candidate.backend}: ${spawned.diagnostic ?? "failed"}`);
			}
			return this.finish({ backend: "none", attempted: true, success: false, diagnostic: diagnostics.join(", ") });
		} catch (error) {
			// §23.2 property 13: sound failure never changes the prompt outcome.
			return this.finish({ backend: "none", attempted: true, success: false, diagnostic: String(error) });
		}
	}

	private finish(result: CompletionSoundResult): CompletionSoundResult {
		this.lastResult = result;
		try {
			this.deps.onResult?.(result);
		} catch {
			// Observability must never affect the sound path.
		}
		return result;
	}
}
