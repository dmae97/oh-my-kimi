import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { fgOrPlain } from "../../modes/theme/theme";
import { QrCode, renderQrHalfBlocks } from "../../utils/qrcode";

/**
 * One-shot transcript block that prints a collab browser-join URL as a
 * scannable QR code. The symbol is encoded once at construction (byte mode,
 * EC level M) and rendered as ANSI half-blocks; on terminals too narrow for
 * the symbol it degrades to a one-line hint pointing at the printed URL.
 */
export class CollabQrCodeComponent implements Component {
	readonly #lines: readonly string[];
	readonly #minWidth: number;

	constructor(readonly url: string) {
		const rows = renderQrHalfBlocks(QrCode.encodeText(url, "M"));
		this.#lines = rows.map(row => ` ${row}`);
		this.#minWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row)), 0) + 1;
	}

	render(width: number): readonly string[] {
		if (width < this.#minWidth) {
			const warning = `QR code hidden: terminal width ${width}; need ${this.#minWidth}. Use the browser URL above.`;
			return [` ${fgOrPlain("warning", warning)}`];
		}
		return this.#lines;
	}
}
