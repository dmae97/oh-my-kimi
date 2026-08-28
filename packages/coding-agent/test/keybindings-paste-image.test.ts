/**
 * Reachability of the image-paste keybinding.
 *
 * A default binding is only useful if the host terminal actually delivers the
 * keypress. Windows Terminal binds `ctrl+v` to its own `Terminal.PasteFromClipboard`
 * action, so under Windows Terminal — including a WSL session inside it — a
 * ctrl+v-only default can never fire: the terminal consumes the key, tries to
 * paste clipboard *text*, finds an image after a Win+Shift+S capture, and
 * nothing reaches the agent at all.
 */
import { describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../src/core/keybindings.ts";

/** Terminals commonly reserve this for their own paste action. */
const HOST_RESERVED_KEY = "ctrl+v";

function defaultKeysFor(action: "app.clipboard.pasteImage"): readonly string[] {
	const keys = KEYBINDINGS[action].defaultKeys;
	return Array.isArray(keys) ? keys : [keys];
}

describe("app.clipboard.pasteImage default keys", () => {
	it("offers a key the host terminal does not reserve", () => {
		const keys = defaultKeysFor("app.clipboard.pasteImage");

		expect(keys.some((key) => key !== HOST_RESERVED_KEY)).toBe(true);
	});

	it("still offers ctrl+v for terminals that deliver it", () => {
		expect(defaultKeysFor("app.clipboard.pasteImage")).toContain(HOST_RESERVED_KEY);
	});

	it("declares no duplicate keys", () => {
		const keys = defaultKeysFor("app.clipboard.pasteImage");

		expect(new Set(keys).size).toBe(keys.length);
	});
});
