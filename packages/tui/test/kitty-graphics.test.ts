import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { visibleWidth } from "@oh-my-pi/pi-natives";
import {
	detectKittyUnicodePlaceholdersSupport,
	encodeKittyPlaceholderGrid,
	encodeKittyTempFileProbe,
	encodeKittyTempFileTransmit,
	encodeKittyVirtualPlacement,
	getKittyGraphics,
	isPngBase64,
	KITTY_PLACEHOLDER,
	KITTY_PLACEHOLDER_MAX_CELLS,
	kittyPlaceholdersFit,
	kittyTempFileAllowed,
	renderKittyPlaceholderLines,
	setKittyGraphics,
} from "@oh-my-pi/pi-tui/kitty-graphics";

const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ORIGINAL = { ...getKittyGraphics() };

afterEach(() => {
	setKittyGraphics(ORIGINAL);
});

describe("kitty Unicode placeholder encoding", () => {
	it("encodeKittyVirtualPlacement emits a=p with U=1 and the id/placement/geometry", () => {
		expect(encodeKittyVirtualPlacement({ imageId: 7, placementId: 7, columns: 4, rows: 2 })).toBe(
			"\x1b_Ga=p,U=1,q=2,i=7,p=7,c=4,r=2\x1b\\",
		);
		// Placement id is omitted when absent.
		expect(encodeKittyVirtualPlacement({ imageId: 7, columns: 4, rows: 2 })).toBe(
			"\x1b_Ga=p,U=1,q=2,i=7,c=4,r=2\x1b\\",
		);
	});

	it("encodeKittyPlaceholderGrid returns one row per line with explicit row+column cells", () => {
		const grid = encodeKittyPlaceholderGrid({ imageId: 1, placementId: 1, columns: 3, rows: 2 });
		expect(grid).toHaveLength(2);
		for (const row of grid) {
			// Image id in foreground color, placement id in underline color, reset at end.
			expect(row).toContain("\x1b[38;2;0;0;1m");
			expect(row).toContain("\x1b[58:2::0:0:1m");
			expect(row.endsWith("\x1b[39;59m")).toBe(true);
			// Exactly `columns` placeholder base characters.
			expect([...row].filter(ch => ch === KITTY_PLACEHOLDER)).toHaveLength(3);
		}
		// Distinct rows carry distinct row diacritics (robust under slicing).
		expect(grid[0]).not.toBe(grid[1]);
	});

	it("a placeholder row measures exactly `columns` cells wide", () => {
		const grid = encodeKittyPlaceholderGrid({ imageId: 5, placementId: 5, columns: 6, rows: 1 });
		// Each placeholder cell (U+10EEEE + diacritics) is one terminal column; the
		// SGR runs are zero-width. This is what keeps renderer/terminal accounting aligned.
		expect(visibleWidth(grid[0]!, 3)).toBe(6);
	});

	it("renderKittyPlaceholderLines prefixes line 0 with the virtual placement APC", () => {
		const opts = { imageId: 2, placementId: 2, columns: 2, rows: 3 } as const;
		const placement = encodeKittyVirtualPlacement(opts);
		const grid = encodeKittyPlaceholderGrid(opts);
		const lines = renderKittyPlaceholderLines(opts);
		expect(lines).toHaveLength(3);
		// Line 0 is the placement APC + the first grid row; later rows are unchanged.
		expect(lines[0]).toBe(placement + grid[0]);
		expect(lines.slice(1)).toEqual(grid.slice(1));
	});

	it("kittyPlaceholdersFit guards the diacritic table capacity", () => {
		expect(kittyPlaceholdersFit(1, 1)).toBe(true);
		expect(kittyPlaceholdersFit(KITTY_PLACEHOLDER_MAX_CELLS, KITTY_PLACEHOLDER_MAX_CELLS)).toBe(true);
		expect(kittyPlaceholdersFit(0, 5)).toBe(false);
		expect(kittyPlaceholdersFit(5, 0)).toBe(false);
		expect(kittyPlaceholdersFit(KITTY_PLACEHOLDER_MAX_CELLS + 1, 1)).toBe(false);
		expect(kittyPlaceholdersFit(1, KITTY_PLACEHOLDER_MAX_CELLS + 1)).toBe(false);
	});
});

describe("kitty temp-file transmission", () => {
	it("isPngBase64 recognizes PNG payloads only", () => {
		expect(isPngBase64(ONE_PIXEL_PNG)).toBe(true);
		expect(isPngBase64("/9j/4AAQSkZJRgABAQ")).toBe(false); // JPEG magic
		expect(isPngBase64("")).toBe(false);
	});

	it("encodeKittyTempFileTransmit writes the bytes to a magic-named file and sends its path", () => {
		const seq = encodeKittyTempFileTransmit(ONE_PIXEL_PNG, 12);
		expect(seq).not.toBeNull();
		const match = seq!.match(/^\x1b_Ga=t,f=100,t=t,S=(\d+),q=2,i=12;([^\x1b]+)\x1b\\$/);
		expect(match).not.toBeNull();
		const [, sizeRaw, encodedPath] = match!;
		const filePath = Buffer.from(encodedPath!, "base64").toString("utf8");
		// Kitty only deletes temp files whose path contains this substring.
		expect(filePath).toContain("tty-graphics-protocol");
		try {
			const written = fs.readFileSync(filePath);
			expect(written.equals(Buffer.from(ONE_PIXEL_PNG, "base64"))).toBe(true);
			expect(Number(sizeRaw)).toBe(written.length);
		} finally {
			fs.rmSync(filePath, { force: true });
		}
	});

	it("encodeKittyTempFileProbe builds an a=q,t=t query and cleans up its file", () => {
		const probe = encodeKittyTempFileProbe(99);
		expect(probe).not.toBeNull();
		expect(probe!.sequence).toContain("\x1b_Ga=q,t=t,f=100,");
		expect(probe!.sequence).toContain("i=99;");
		const encodedPath = probe!.sequence.match(/;([^\x1b]+)\x1b\\$/)?.[1];
		const filePath = Buffer.from(encodedPath!, "base64").toString("utf8");
		expect(fs.existsSync(filePath)).toBe(true);
		probe!.cleanup();
		expect(fs.existsSync(filePath)).toBe(false);
	});
});

describe("kitty graphics feature state", () => {
	it("getKittyGraphics/setKittyGraphics round-trips overrides", () => {
		setKittyGraphics({ unicodePlaceholders: false, transmissionMedium: "temp-file" });
		expect(getKittyGraphics()).toEqual({ unicodePlaceholders: false, transmissionMedium: "temp-file" });
		setKittyGraphics({ unicodePlaceholders: true });
		expect(getKittyGraphics().unicodePlaceholders).toBe(true);
		expect(getKittyGraphics().transmissionMedium).toBe("temp-file");
	});

	it("kittyTempFileAllowed honors env force/off and the remote-session guard", () => {
		const keys = ["PI_KITTY_IMAGE_TRANSMISSION", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];
		const saved: Record<string, string | undefined> = {};
		for (const k of keys) saved[k] = Bun.env[k];
		const restore = () => {
			for (const k of keys) {
				const v = saved[k];
				if (v === undefined) delete Bun.env[k];
				else Bun.env[k] = v;
			}
		};
		try {
			for (const k of keys) delete Bun.env[k];
			// Auto + local session: allowed.
			expect(kittyTempFileAllowed()).toBe(true);
			// Auto + SSH session: not allowed.
			Bun.env.SSH_CONNECTION = "1.2.3.4 5 6.7.8.9 22";
			expect(kittyTempFileAllowed()).toBe(false);
			// Explicit force overrides the remote guard.
			Bun.env.PI_KITTY_IMAGE_TRANSMISSION = "temp-file";
			expect(kittyTempFileAllowed()).toBe(true);
			// Explicit off wins even on a local session.
			delete Bun.env.SSH_CONNECTION;
			Bun.env.PI_KITTY_IMAGE_TRANSMISSION = "direct";
			expect(kittyTempFileAllowed()).toBe(false);
		} finally {
			restore();
		}
	});
});

describe("detectKittyUnicodePlaceholdersSupport", () => {
	function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
		return extra as NodeJS.ProcessEnv;
	}

	it("enables for kitty and ghostty by default (the only terminals that render U=1 placement)", () => {
		expect(detectKittyUnicodePlaceholdersSupport("kitty", env())).toBe(true);
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", env())).toBe(true);
	});

	it("disables for wezterm and other Kitty-protocol paths that treat placeholders as literal PUA glyphs (#1877)", () => {
		expect(detectKittyUnicodePlaceholdersSupport("wezterm", env())).toBe(false);
		// Tmux/screen fallback: base terminal id with Kitty protocol forced on by
		// `getFallbackImageProtocol`. The outer terminal need not understand U=1.
		expect(detectKittyUnicodePlaceholdersSupport("base", env())).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("iterm2", env())).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("alacritty", env())).toBe(false);
	});

	it("honors PI_NO_KITTY_PLACEHOLDERS=1 as a hard off override on supporting terminals", () => {
		expect(detectKittyUnicodePlaceholdersSupport("kitty", env({ PI_NO_KITTY_PLACEHOLDERS: "1" }))).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", env({ PI_NO_KITTY_PLACEHOLDERS: "true" }))).toBe(false);
	});

	it("honors PI_KITTY_PLACEHOLDERS=1 as opt-in on otherwise-unsupported terminals", () => {
		expect(detectKittyUnicodePlaceholdersSupport("wezterm", env({ PI_KITTY_PLACEHOLDERS: "1" }))).toBe(true);
	});

	it("PI_NO_KITTY_PLACEHOLDERS beats PI_KITTY_PLACEHOLDERS when both are set", () => {
		const both = env({ PI_NO_KITTY_PLACEHOLDERS: "1", PI_KITTY_PLACEHOLDERS: "1" });
		expect(detectKittyUnicodePlaceholdersSupport("kitty", both)).toBe(false);
	});

	it("PI_KITTY_PLACEHOLDERS=0 forces off on a default-on terminal", () => {
		expect(detectKittyUnicodePlaceholdersSupport("kitty", env({ PI_KITTY_PLACEHOLDERS: "0" }))).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", env({ PI_KITTY_PLACEHOLDERS: "off" }))).toBe(false);
	});
});
