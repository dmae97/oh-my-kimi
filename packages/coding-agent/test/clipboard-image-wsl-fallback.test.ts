/**
 * WSL clipboard fallback ordering.
 *
 * On WSL, WSLg exposes a Windows screenshot as `image/bmp`, so the wl-paste read
 * succeeds — and that success used to disqualify the PowerShell fallback, which
 * reads the Windows clipboard directly and already returns PNG. When BMP
 * conversion was unavailable the whole read then returned null and the paste
 * silently did nothing, even though a working source was one step away.
 */
import { describe, expect, test, vi } from "vitest";

/** Minimal 1x1 24bpp BMP: header + DIB header + one padded pixel row. */
function tinyBmp(): Uint8Array {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return new Uint8Array(buffer);
}

/** PNG magic plus a byte, standing in for what PowerShell saves to disk. */
const POWERSHELL_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

const WSL_TEMP_MARKER = "omk-wsl-clip-";

vi.mock("child_process", async () => {
	const actual = await vi.importActual<typeof import("child_process")>("child_process");
	return {
		...actual,
		spawnSync: vi.fn((command: string, args: string[]) => {
			if (command === "wl-paste" && args.includes("--list-types")) {
				return { status: 0, stdout: Buffer.from("image/bmp\n"), error: null };
			}
			if (command === "wl-paste" && args.includes("image/bmp")) {
				return { status: 0, stdout: Buffer.from(tinyBmp()), error: null };
			}
			if (command === "wslpath") {
				return { status: 0, stdout: Buffer.from("C:\\Temp\\clip.png\n"), error: null };
			}
			if (command === "powershell.exe") {
				return { status: 0, stdout: Buffer.from("ok\n"), error: null };
			}
			return { status: 1, stdout: Buffer.alloc(0), error: null };
		}),
	};
});

// The PowerShell path saves a PNG and reads it back; serve those bytes.
vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs");
	return {
		...actual,
		readFileSync: vi.fn((file: unknown, ...rest: unknown[]) => {
			if (typeof file === "string" && file.includes(WSL_TEMP_MARKER)) {
				return Buffer.from(POWERSHELL_PNG);
			}
			return (actual.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
		}),
		unlinkSync: vi.fn(),
	};
});

// Photon unavailable: exactly the state of a packaged binary whose wasm sidecar
// is missing, which is what makes BMP unconvertible.
vi.mock("../src/utils/photon.ts", () => ({ loadPhoton: vi.fn(async () => null) }));

vi.mock("@mariozechner/clipboard", () => ({
	default: { hasImage: vi.fn(() => false), getImageBinary: vi.fn(() => Promise.resolve(null)) },
}));

describe("readClipboardImage on WSL when BMP cannot be converted", () => {
	test("falls through to the PowerShell reader instead of giving up", async () => {
		// Given WSLg offering only image/bmp and no converter available
		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");

		// When the editor asks for the clipboard image after a Windows capture
		const image = await readClipboardImage({ env: { WSL_DISTRO_NAME: "Ubuntu" }, platform: "linux" });

		// Then the Windows clipboard still supplies a usable PNG
		expect(image).not.toBeNull();
		expect(image?.mimeType).toBe("image/png");
		expect(Array.from(image?.bytes.slice(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});
});
