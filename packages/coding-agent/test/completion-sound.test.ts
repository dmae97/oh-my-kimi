import { describe, expect, it } from "vitest";
import {
	type CompletionSoundCandidate,
	type CompletionSoundIo,
	CompletionSoundService,
	resolveCompletionSoundSettings,
	selectCompletionSoundCandidates,
	shouldPlayCompletionSound,
} from "../src/core/completion-sound.ts";
import type { PromptSettledEvent } from "../src/core/prompt-settlement.ts";

function settledEvent(overrides: Partial<PromptSettledEvent> = {}): PromptSettledEvent {
	return { type: "prompt_settled", promptRunId: "run-1", outcome: "completed", durationMs: 10_000, ...overrides };
}

const TUI_SURFACE = { isTui: true, isTty: true, isCi: false } as const;

describe("resolveCompletionSoundSettings (§17.1, §18.2)", () => {
	it("defaults to disabled with the documented values", () => {
		expect(resolveCompletionSoundSettings(undefined, {})).toEqual({
			enabled: false,
			minDurationMs: 5000,
			onSuccess: true,
			onFailure: true,
			terminalBellFallback: true,
		});
	});

	it("lets OMK_COMPLETION_SOUND override enabled in both directions", () => {
		expect(resolveCompletionSoundSettings({ enabled: true }, { OMK_COMPLETION_SOUND: "0" }).enabled).toBe(false);
		expect(resolveCompletionSoundSettings({ enabled: false }, { OMK_COMPLETION_SOUND: "1" }).enabled).toBe(true);
		expect(resolveCompletionSoundSettings({ enabled: true }, {}).enabled).toBe(true);
	});
});

describe("shouldPlayCompletionSound (§17.1, §17.4)", () => {
	const enabled = resolveCompletionSoundSettings({ enabled: true }, {});

	it("plays only on an interactive non-CI TTY", () => {
		expect(shouldPlayCompletionSound({ settings: enabled, event: settledEvent(), surface: TUI_SURFACE })).toBe(true);
		expect(
			shouldPlayCompletionSound({
				settings: enabled,
				event: settledEvent(),
				surface: { ...TUI_SURFACE, isTui: false },
			}),
		).toBe(false);
		expect(
			shouldPlayCompletionSound({
				settings: enabled,
				event: settledEvent(),
				surface: { ...TUI_SURFACE, isTty: false },
			}),
		).toBe(false);
		expect(
			shouldPlayCompletionSound({
				settings: enabled,
				event: settledEvent(),
				surface: { ...TUI_SURFACE, isCi: true },
			}),
		).toBe(false);
	});

	it("honors the duration floor and outcome switches; aborts never chime", () => {
		expect(
			shouldPlayCompletionSound({
				settings: enabled,
				event: settledEvent({ durationMs: 4_999 }),
				surface: TUI_SURFACE,
			}),
		).toBe(false);
		const noSuccess = resolveCompletionSoundSettings({ enabled: true, onSuccess: false }, {});
		expect(shouldPlayCompletionSound({ settings: noSuccess, event: settledEvent(), surface: TUI_SURFACE })).toBe(
			false,
		);
		const noFailure = resolveCompletionSoundSettings({ enabled: true, onFailure: false }, {});
		expect(
			shouldPlayCompletionSound({
				settings: noFailure,
				event: settledEvent({ outcome: "failed" }),
				surface: TUI_SURFACE,
			}),
		).toBe(false);
		expect(
			shouldPlayCompletionSound({
				settings: enabled,
				event: settledEvent({ outcome: "aborted" }),
				surface: TUI_SURFACE,
			}),
		).toBe(false);
	});
});

describe("selectCompletionSoundCandidates (§17.3, §23.2 property 14)", () => {
	it("is deterministic per platform fixture", () => {
		const backends = (platform: NodeJS.Platform, isWsl = false) =>
			selectCompletionSoundCandidates({ platform, isWsl, terminalBellFallback: true }).map((c) => c.backend);
		expect(backends("darwin")).toEqual(["macos-afplay", "terminal-bell"]);
		expect(backends("win32")).toEqual(["windows-system-sound", "terminal-bell"]);
		expect(backends("linux", true)).toEqual(["windows-system-sound", "terminal-bell"]);
		expect(backends("linux")).toEqual(["linux-canberra", "linux-paplay", "linux-aplay", "terminal-bell"]);
		expect(backends("freebsd")).toEqual(["terminal-bell"]);
	});

	it("uses fixed argv with no interpolation surface (§22.1)", () => {
		for (const candidate of selectCompletionSoundCandidates({
			platform: "linux",
			isWsl: false,
			terminalBellFallback: true,
		})) {
			for (const token of candidate.argv) {
				expect(token).not.toContain("$");
				expect(token).not.toContain("`");
			}
		}
		const noBell = selectCompletionSoundCandidates({ platform: "linux", isWsl: false, terminalBellFallback: false });
		expect(noBell.map((c) => c.backend)).not.toContain("terminal-bell");
	});
});

describe("CompletionSoundService", () => {
	function makeService(input: {
		readonly candidates: readonly CompletionSoundCandidate[];
		readonly io: CompletionSoundIo;
		readonly enabled?: boolean;
	}) {
		return new CompletionSoundService({
			getSettings: () => ({ enabled: input.enabled ?? true, minDurationMs: 0 }),
			surface: () => TUI_SURFACE,
			candidates: () => input.candidates,
			io: input.io,
			env: {},
		});
	}

	it("walks the candidate chain on spawn failure and lands on the bell", async () => {
		const attempts: string[] = [];
		const service = makeService({
			candidates: selectCompletionSoundCandidates({ platform: "linux", isWsl: false, terminalBellFallback: true }),
			io: {
				spawnBackend: async (argv) => {
					attempts.push(argv[0]);
					return { ok: false, diagnostic: "ENOENT" };
				},
				writeBell: () => true,
			},
		});
		const result = await service.handleSettled(settledEvent());
		expect(attempts).toEqual(["canberra-gtk-play", "paplay", "aplay"]);
		expect(result.backend).toBe("terminal-bell");
		expect(result.success).toBe(true);
		expect(result.diagnostic).toContain("linux-canberra: ENOENT");
	});

	it("plays exactly once per promptRunId (§17.4)", async () => {
		let spawns = 0;
		const service = makeService({
			candidates: [{ backend: "macos-afplay", argv: ["afplay", "/System/Library/Sounds/Glass.aiff"] }],
			io: {
				spawnBackend: async () => {
					spawns += 1;
					return { ok: true };
				},
				writeBell: () => true,
			},
		});
		const first = await service.handleSettled(settledEvent());
		const second = await service.handleSettled(settledEvent());
		expect(first).toMatchObject({ backend: "macos-afplay", attempted: true, success: true });
		expect(second).toMatchObject({ backend: "none", attempted: false, diagnostic: "already_played" });
		expect(spawns).toBe(1);
	});

	it("property 13 (§23.2): backend failure resolves a diagnostic result, never a throw", async () => {
		const service = makeService({
			candidates: [{ backend: "macos-afplay", argv: ["afplay", "x"] }],
			io: {
				spawnBackend: async () => {
					throw new Error("backend exploded");
				},
				writeBell: () => {
					throw new Error("bell exploded");
				},
			},
		});
		const result = await service.handleSettled(settledEvent());
		expect(result.success).toBe(false);
		expect(result.diagnostic).toContain("backend exploded");
	});

	it("skips silently when disabled without consuming the run id", async () => {
		const service = makeService({
			candidates: [{ backend: "terminal-bell", argv: [] }],
			io: { spawnBackend: async () => ({ ok: true }), writeBell: () => true },
			enabled: false,
		});
		const result = await service.handleSettled(settledEvent());
		expect(result).toMatchObject({ backend: "none", attempted: false, success: true });
	});
});
