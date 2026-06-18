const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export type PasteResult = { handled: false } | { handled: true; pasteContent?: string; remaining: string };

// Some terminals re-encode the control bytes inside a bracketed paste as key-event
// escape sequences (observed with tmux extended-keys passthrough under kitty). tmux
// emits one of two formats depending on `extended-keys-format`:
//   - csi-u:  ESC [ <codepoint> ; 5 u        (Ctrl+J → ESC [ 106 ; 5 u)
//   - xterm:  ESC [ 27 ; 5 ; <codepoint> ~   (Ctrl+J → ESC [ 27 ; 5 ; 106 ~)
// Callers must decode these back to the literal control byte (Ctrl+J → "\n") before
// stripping control chars; otherwise ESC is dropped and the printable tail
// ("[106;5u" / "[27;5;106~") leaks into the editor.
//
// Only Ctrl+<letter> is decoded (codepoint a-z/A-Z → 0x01..0x1A). That is the set tmux
// actually re-encodes from paste content in practice — TAB (Ctrl+I), LF (Ctrl+J), CR
// (Ctrl+M), VT (Ctrl+K), FF (Ctrl+L), … Non-letter Ctrl combos (NUL, ESC, FS-US, DEL)
// never appear as re-encoded paste bytes, so they are left untouched rather than
// synthesized into raw control bytes. Callers still strip leftover control characters
// after decoding (the editor keeps "\n"; the single-line input strips all of them).
const REENCODED_CTRL_CSI_U = /\x1b\[(\d+);5u/g;
const REENCODED_CTRL_XTERM = /\x1b\[27;5;(\d+)~/g;

function decodeReencodedCtrlByte(match: string, code: string): string {
	const cp = Number(code);
	if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96); // a-z → Ctrl+A..Ctrl+Z
	if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64); // A-Z → Ctrl+A..Ctrl+Z
	return match;
}

/**
 * Decode tmux's re-encoded control bytes (both `extended-keys-format` variants) inside a
 * bracketed-paste payload back to their literal byte (e.g. Ctrl+J → "\n"). Leaves the rest of
 * the text untouched. Call before any control-character stripping so newlines/tabs survive
 * instead of leaking the printable escape tail into the buffer.
 */
export function decodeReencodedPasteControls(text: string): string {
	return text
		.replace(REENCODED_CTRL_CSI_U, decodeReencodedCtrlByte)
		.replace(REENCODED_CTRL_XTERM, decodeReencodedCtrlByte);
}

/**
 * Handles bracketed paste mode buffering for terminal input components.
 *
 * Bracketed paste mode wraps pasted content between start (\x1b[200~) and
 * end (\x1b[201~) markers, which may arrive split across multiple chunks.
 * This class buffers incoming data and assembles complete paste payloads.
 */
export class BracketedPasteHandler {
	#buffer = "";
	#active = false;

	/**
	 * Process incoming terminal data for bracketed paste sequences.
	 *
	 * @returns `{ handled: false }` if the data contains no paste sequence and
	 *          should be processed normally. `{ handled: true }` if the data was
	 *          consumed by paste buffering — `pasteContent` is set when a complete
	 *          paste has been assembled; omitted when still buffering.
	 */
	process(data: string): PasteResult {
		if (data.includes(PASTE_START)) {
			this.#active = true;
			this.#buffer = "";
			data = data.replace(PASTE_START, "");
		}

		if (!this.#active) return { handled: false };

		this.#buffer += data;

		const endIndex = this.#buffer.indexOf(PASTE_END);
		if (endIndex === -1) return { handled: true, remaining: "" };

		const pasteContent = this.#buffer.substring(0, endIndex);
		const remaining = this.#buffer.substring(endIndex + PASTE_END.length);

		this.#buffer = "";
		this.#active = false;

		return { handled: true, pasteContent, remaining };
	}
}
