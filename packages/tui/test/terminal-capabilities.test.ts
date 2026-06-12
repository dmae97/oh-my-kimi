import { describe, expect, it } from "bun:test";
import {
	shouldEnableSynchronizedOutputByDefault,
	synchronizedOutputUserOverride,
} from "@oh-my-pi/pi-tui/terminal-capabilities";

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
