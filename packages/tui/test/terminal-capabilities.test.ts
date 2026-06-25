import { describe, expect, it } from "bun:test";
import {
	detectTerminalId,
	getTerminalInfo,
	hyperlinksUserOverride,
	ImageProtocol,
	shouldEnableHyperlinksByDefault,
	shouldEnableSynchronizedOutputByDefault,
	synchronizedOutputUserOverride,
} from "@oh-my-pi/pi-tui/terminal-capabilities";

describe("detectTerminalId", () => {
	it("recognizes Warp before the true-color fallback", () => {
		expect(detectTerminalId({ TERM_PROGRAM: "WarpTerminal", COLORTERM: "truecolor" })).toBe("warp");
	});
});

describe("synchronizedOutputUserOverride", () => {
	it("returns null when the user expresses no preference", () => {
		expect(synchronizedOutputUserOverride({})).toBeNull();
		expect(synchronizedOutputUserOverride({ TERM: "xterm-256color" })).toBeNull();
	});

	it("returns false for either opt-out flag", () => {
		expect(synchronizedOutputUserOverride({ PI_NO_SYNC_OUTPUT: "1" })).toBe(false);
		expect(synchronizedOutputUserOverride({ PI_TUI_SYNC_OUTPUT: "0" })).toBe(false);
	});

	it("returns true for either force-on flag", () => {
		expect(synchronizedOutputUserOverride({ PI_FORCE_SYNC_OUTPUT: "1" })).toBe(true);
		expect(synchronizedOutputUserOverride({ PI_TUI_SYNC_OUTPUT: "1" })).toBe(true);
	});

	it("resolves opt-out ahead of force-on when both are set", () => {
		expect(synchronizedOutputUserOverride({ PI_NO_SYNC_OUTPUT: "1", PI_FORCE_SYNC_OUTPUT: "1" })).toBe(false);
		expect(synchronizedOutputUserOverride({ PI_TUI_SYNC_OUTPUT: "0", PI_FORCE_SYNC_OUTPUT: "1" })).toBe(false);
	});
});

describe("shouldEnableSynchronizedOutputByDefault", () => {
	it("enables sync for every known direct terminal, including Alacritty and VS Code", () => {
		for (const id of ["kitty", "ghostty", "wezterm", "iterm2", "alacritty", "vscode"] as const) {
			expect(shouldEnableSynchronizedOutputByDefault({}, id)).toBe(true);
		}
	});

	it("enables sync in Windows Terminal / WSL via WT_SESSION regardless of terminal id", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ WT_SESSION: "abc" }, "trueColor")).toBe(true);
		// WSL shape: Linux + WT_SESSION + COLORTERM=truecolor collapses to trueColor id.
		expect(shouldEnableSynchronizedOutputByDefault({ WT_SESSION: "abc", COLORTERM: "truecolor" }, "trueColor")).toBe(
			true,
		);
	});

	it("enables sync when TERM_FEATURES advertises the Sy capability, even through SSH/mux", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ TERM_FEATURES: "ClSyTc" }, "base")).toBe(true);
		expect(
			shouldEnableSynchronizedOutputByDefault({ TERM_FEATURES: "ClSyTc", SSH_CONNECTION: "1 2 3 4" }, "base"),
		).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ TERM_FEATURES: "ClSyTc", TMUX: "1" }, "base")).toBe(true);
	});

	it("does not treat a TERM_FEATURES list without the Sy token as advertising support", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ TERM_FEATURES: "ClTc" }, "base")).toBe(false);
	});

	it("no longer blanket-disables SSH for recognized terminals", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ SSH_CONNECTION: "1 2 3 4" }, "iterm2")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ SSH_TTY: "/dev/pts/3" }, "kitty")).toBe(true);
	});

	it("keeps risky multiplexers off by default even when an inner terminal id leaks", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ TMUX: "1" }, "kitty")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ ZELLIJ: "0" }, "ghostty")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ STY: "x" }, "wezterm")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ TERM: "tmux-256color" }, "iterm2")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ TERM: "screen-256color" }, "kitty")).toBe(false);
	});

	it("keeps known-unsupported and unknown profiles off", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ VTE_VERSION: "6800" }, "base")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ TERM: "xterm-256color" }, "base")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({}, "base")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({}, "trueColor")).toBe(false);
	});

	it("lets a user opt-out beat every positive heuristic", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ PI_NO_SYNC_OUTPUT: "1" }, "kitty")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ PI_TUI_SYNC_OUTPUT: "0" }, "ghostty")).toBe(false);
		expect(
			shouldEnableSynchronizedOutputByDefault(
				{ PI_NO_SYNC_OUTPUT: "1", WT_SESSION: "abc", TERM_FEATURES: "Sy" },
				"kitty",
			),
		).toBe(false);
	});

	it("lets a user force-on beat the conservative defaults", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ PI_FORCE_SYNC_OUTPUT: "1" }, "base")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ PI_TUI_SYNC_OUTPUT: "1", TMUX: "1" }, "base")).toBe(true);
		expect(
			shouldEnableSynchronizedOutputByDefault({ PI_FORCE_SYNC_OUTPUT: "1", SSH_CONNECTION: "1 2 3 4" }, "base"),
		).toBe(true);
	});
});

describe("Warp terminal capabilities", () => {
	it("uses Kitty images on macOS/Linux and disables them on Windows", () => {
		const mac = getTerminalInfo("warp", "darwin");
		const linux = getTerminalInfo("warp", "linux");
		const windows = getTerminalInfo("warp", "win32");

		expect(mac.imageProtocol).toBe(ImageProtocol.Kitty);
		expect(linux.imageProtocol).toBe(ImageProtocol.Kitty);
		expect(windows.imageProtocol).toBeNull();
		expect(linux.trueColor).toBe(true);
		expect(linux.hyperlinks).toBe(false);
		expect(linux.deccara).toBe(false);
		expect(linux.textSizing).toBe(false);
	});

	it("leaves synchronized output off by default and honors hyperlink force-on", () => {
		expect(shouldEnableSynchronizedOutputByDefault({}, "warp")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({}, "warp")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({ PI_FORCE_HYPERLINKS: "1" }, "warp")).toBe(true);
	});
});

describe("hyperlinksUserOverride", () => {
	it("returns null when neither override is set", () => {
		expect(hyperlinksUserOverride({})).toBeNull();
		expect(hyperlinksUserOverride({ TERM: "xterm-256color" })).toBeNull();
	});

	it("returns true for the force-on flag", () => {
		expect(hyperlinksUserOverride({ PI_FORCE_HYPERLINKS: "1" })).toBe(true);
	});

	it("returns false for the opt-out flag", () => {
		expect(hyperlinksUserOverride({ PI_NO_HYPERLINKS: "1" })).toBe(false);
	});

	it("resolves opt-out ahead of force-on when both are set", () => {
		expect(hyperlinksUserOverride({ PI_NO_HYPERLINKS: "1", PI_FORCE_HYPERLINKS: "1" })).toBe(false);
	});

	it("ignores values other than the literal '1'", () => {
		// Mirrors the sync-output knobs: only the canonical `1` toggles them;
		// `true`/`yes` are not accepted to keep the contract obvious.
		expect(hyperlinksUserOverride({ PI_FORCE_HYPERLINKS: "true" })).toBeNull();
		expect(hyperlinksUserOverride({ PI_FORCE_HYPERLINKS: "0" })).toBeNull();
		expect(hyperlinksUserOverride({ PI_NO_HYPERLINKS: "0" })).toBeNull();
	});
});

describe("shouldEnableHyperlinksByDefault", () => {
	it("enables hyperlinks on every known direct terminal", () => {
		for (const id of ["kitty", "ghostty", "wezterm", "iterm2", "alacritty", "vscode"] as const) {
			expect(shouldEnableHyperlinksByDefault({}, id)).toBe(true);
		}
	});

	it("keeps the base/trueColor fallback terminals off", () => {
		expect(shouldEnableHyperlinksByDefault({}, "base")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({}, "trueColor")).toBe(false);
	});

	it("keeps GNU screen always off, even when the inner terminal supports OSC 8", () => {
		expect(shouldEnableHyperlinksByDefault({ STY: "1234.pts-0.host" }, "wezterm")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({ TERM: "screen-256color" }, "kitty")).toBe(false);
	});

	it("treats TMUX as authoritative even when TERM is screen-family (tmux's historical default-terminal)", () => {
		// tmux's historical `default-terminal` is `screen-256color`, so a tmux
		// session can have a screen-family TERM. The TMUX env signals tmux is the
		// immediate layer and its version gate must run regardless of TERM.
		expect(
			shouldEnableHyperlinksByDefault(
				{
					TMUX: "/tmp/tmux-1000/default,1,0",
					TERM: "screen-256color",
					TERM_PROGRAM: "tmux",
					TERM_PROGRAM_VERSION: "3.4",
				},
				"wezterm",
			),
		).toBe(true);
		expect(
			shouldEnableHyperlinksByDefault(
				{
					TMUX: "/tmp/tmux-1000/default,1,0",
					TERM: "screen",
					TERM_PROGRAM: "tmux",
					TERM_PROGRAM_VERSION: "3.3a",
				},
				"wezterm",
			),
		).toBe(false);
	});

	it("lets GNU screen's STY marker veto tmux enabling in nested multiplexer sessions", () => {
		expect(
			shouldEnableHyperlinksByDefault(
				{
					STY: "1234.pts-0.host",
					TMUX: "/tmp/tmux-1000/default,1,0",
					TERM_PROGRAM: "tmux",
					TERM_PROGRAM_VERSION: "3.4",
				},
				"wezterm",
			),
		).toBe(false);
		expect(
			shouldEnableHyperlinksByDefault(
				{
					STY: "1234.pts-0.host",
					TMUX: "/tmp/tmux-1000/default,1,0",
					TERM: "screen-256color",
					TERM_PROGRAM: "tmux",
					TERM_PROGRAM_VERSION: "3.5a",
				},
				"kitty",
			),
		).toBe(false);
	});

	it("keeps tmux off when no version is reported (old tmux without TERM_PROGRAM_VERSION)", () => {
		expect(shouldEnableHyperlinksByDefault({ TMUX: "/tmp/tmux-1000/default,1,0" }, "wezterm")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({ TERM: "tmux-256color" }, "wezterm")).toBe(false);
	});

	it("keeps tmux off when self-reported version is below 3.4", () => {
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.3a" },
				"wezterm",
			),
		).toBe(false);
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "2.9" },
				"kitty",
			),
		).toBe(false);
	});

	it("enables tmux >= 3.4 since tmux forwards OSC 8 cell attributes to the outer terminal", () => {
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.4" },
				"wezterm",
			),
		).toBe(true);
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.5a" },
				"wezterm",
			),
		).toBe(true);
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "4.0" },
				"kitty",
			),
		).toBe(true);
	});

	it("respects the static per-terminal flag even when force-on is absent", () => {
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.5a" },
				"base",
			),
		).toBe(false);
	});

	it("lets PI_NO_HYPERLINKS beat every positive heuristic", () => {
		expect(shouldEnableHyperlinksByDefault({ PI_NO_HYPERLINKS: "1" }, "kitty")).toBe(false);
		expect(
			shouldEnableHyperlinksByDefault(
				{ PI_NO_HYPERLINKS: "1", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.5a", TMUX: "1" },
				"wezterm",
			),
		).toBe(false);
	});

	it("lets PI_FORCE_HYPERLINKS override the conservative defaults (old tmux, screen, base terminal)", () => {
		expect(shouldEnableHyperlinksByDefault({ PI_FORCE_HYPERLINKS: "1" }, "base")).toBe(true);
		expect(shouldEnableHyperlinksByDefault({ PI_FORCE_HYPERLINKS: "1", TMUX: "1" }, "wezterm")).toBe(true);
		expect(shouldEnableHyperlinksByDefault({ PI_FORCE_HYPERLINKS: "1", STY: "1.pts-0" }, "kitty")).toBe(true);
	});
});
