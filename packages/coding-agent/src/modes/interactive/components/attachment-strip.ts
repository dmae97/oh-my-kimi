/**
 * Terminal preview strip for prompt image attachments.
 *
 * Default renderer is ANSI truecolor half-block ("▀" = two vertical pixels per
 * cell) — works everywhere, no protocol negotiation. Decoding goes through
 * Photon when available; failures degrade to a metadata-only tile instead of
 * hiding the paste. Previews are cached per (attachment, width).
 */

import { truncateToWidth } from "omk-tui";
import { describePromptImageAttachment, type PromptImageAttachment } from "../../../core/prompt-attachment.ts";
import { loadPhoton } from "../../../utils/photon.ts";
import { theme } from "../theme/theme.ts";

const PREVIEW_ROWS = 6;
const MAX_TILES = 3;

export interface AttachmentStripHandle {
	render(width: number): string[];
	invalidate(): void;
}

interface DecodedImage {
	width: number;
	height: number;
	rgba: Uint8Array;
}

const decodeCache = new Map<string, DecodedImage | null>();

async function decodeToRgba(id: string, bytes: Uint8Array | undefined): Promise<DecodedImage | null> {
	const cached = decodeCache.get(id);
	if (cached !== undefined) return cached;
	let decoded: DecodedImage | null = null;
	if (bytes && bytes.length > 0) {
		try {
			const photon = await loadPhoton();
			if (photon) {
				const image = photon.PhotonImage.new_from_byteslice(bytes);
				try {
					const width = image.get_width();
					const height = image.get_height();
					const raw =
						typeof (image as { get_image_data?: unknown }).get_image_data === "function"
							? (image as unknown as { get_image_data: () => Uint8Array }).get_image_data()
							: image.get_bytes();
					if (width > 0 && height > 0 && raw.length >= width * height * 4) {
						decoded = { width, height, rgba: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) };
					}
				} finally {
					image.free();
				}
			}
		} catch {
			decoded = null;
		}
	}
	decodeCache.set(id, decoded);
	return decoded;
}

/** Render one attachment as truecolor half-block lines inside a thin box. */
function renderTile(index: number, attachment: PromptImageAttachment, tileWidth: number): string[] {
	const muted = (text: string) => theme.fg("muted", text);
	/** Hard width cap: a wrapped border row drifts the line-count-based viewport. */
	const fitToTileWidth = (text: string) => truncateToWidth(text, tileWidth);
	const title = ` Image ${index} `;
	const top = fitToTileWidth(muted(`┌${title}${"─".repeat(Math.max(0, tileWidth - title.length - 1))}┐`));
	const footerText = describePromptImageAttachment(attachment);
	const footer = fitToTileWidth(
		muted(`└ ${footerText}${"─".repeat(Math.max(0, tileWidth - footerText.length - 3))}┘`),
	);

	const inner = tileWidth - 2;
	const lines: string[] = [top];

	if (inner < 8) {
		lines.push(fitToTileWidth(muted(`│ ${footerText.slice(0, inner)} │`)), footer);
		return lines;
	}

	const decoded = decodeCache.get(attachment.id);
	if (!decoded) {
		// Metadata-only fallback (decode unavailable or still pending).
		for (let row = 0; row < PREVIEW_ROWS; row += 1) {
			const label = row === Math.floor(PREVIEW_ROWS / 2) ? "🖼 no preview" : "";
			lines.push(fitToTileWidth(muted(`│${(label + " ".repeat(inner)).slice(0, inner)}│`)));
		}
		lines.push(footer);
		return lines;
	}

	const cellRows = PREVIEW_ROWS * 2;
	for (let row = 0; row < PREVIEW_ROWS; row += 1) {
		let line = "";
		for (let col = 0; col < inner; col += 1) {
			const sy = Math.floor(((row * 2 + 0.5) / cellRows) * decoded.height);
			const syBottom = Math.min(decoded.height - 1, Math.floor(((row * 2 + 1.5) / cellRows) * decoded.height));
			const sx = Math.floor(((col + 0.5) / inner) * decoded.width);
			const top_ = samplePixelAt(decoded, sx, sy);
			const bottom = samplePixelAt(decoded, sx, syBottom);
			line += `\x1b[38;2;${top_[0]};${top_[1]};${top_[2]}m\x1b[48;2;${bottom[0]};${bottom[1]};${bottom[2]}m▀\x1b[0m`;
		}
		lines.push(fitToTileWidth(muted("│") + line + muted("│")));
	}
	lines.push(footer);
	return lines;
}

function samplePixelAt(decoded: DecodedImage, x: number, y: number): [number, number, number] {
	const clampedX = Math.min(x, decoded.width - 1);
	const clampedY = Math.min(y, decoded.height - 1);
	const offset = (clampedY * decoded.width + clampedX) * 4;
	return [decoded.rgba[offset], decoded.rgba[offset + 1], decoded.rgba[offset + 2]];
}

/**
 * Build the strip component. `getBytes` supplies raw bytes for decoding;
 * `onHintAction` is reserved for future interactive removal.
 */
export function createAttachmentStrip(
	attachments: readonly PromptImageAttachment[],
	getBytes: (id: string) => Uint8Array | undefined,
	_onHintAction?: () => void,
): AttachmentStripHandle {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	void (async () => {
		for (const attachment of attachments) {
			await decodeToRgba(attachment.id, getBytes(attachment.id));
		}
		cachedWidth = undefined; // force re-render once decodes settle
	})();

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const lines: string[] = [];
			const shown = attachments.slice(0, MAX_TILES);
			const tileWidth = Math.min(44, Math.max(16, width - 6));
			shown.forEach((attachment, index) => {
				lines.push(...renderTile(index + 1, attachment, tileWidth));
			});
			const hidden = attachments.length - shown.length;
			if (hidden > 0) {
				lines.push(
					truncateToWidth(theme.fg("muted", `+${hidden} more attached (${attachments.length} total)`), width),
				);
			}
			cachedWidth = width;
			cachedLines = lines;
			return lines;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}

/** Test hook: drop memoized decodes. */
export function resetAttachmentDecodeCache(): void {
	decodeCache.clear();
}
