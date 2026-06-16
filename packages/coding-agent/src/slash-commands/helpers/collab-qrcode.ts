import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import * as QRCode from "qrcode";
import { theme } from "../../modes/theme/theme";

export async function renderCollabQrCode(url: string): Promise<string> {
	return QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" });
}

export class CollabQrCodeComponent implements Component {
	readonly url: string;
	readonly #lines: readonly string[];
	readonly #minWidth: number;

	constructor(url: string, qrText: string) {
		this.url = url;
		const lines = qrText.split(/\r?\n/);
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		this.#lines = lines;
		this.#minWidth = 1 + lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	}

	render(width: number): readonly string[] {
		if (width < this.#minWidth) {
			const warning = `QR code hidden: terminal width ${width}; need ${this.#minWidth}. Use the browser URL above.`;
			return [` ${typeof theme === "undefined" ? warning : theme.fg("warning", warning)}`];
		}
		return this.#lines.map(line => ` ${line}`);
	}
}
