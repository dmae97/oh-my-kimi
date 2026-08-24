import { visibleWidth } from "omk-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../src/core/attachment-store.ts";
import {
	createAttachmentStrip,
	resetAttachmentDecodeCache,
} from "../src/modes/interactive/components/attachment-strip.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

/**
 * Regression (scroll-drift class): every line a TUI component renders must fit
 * within the width it was rendered at. The differential renderer's viewport
 * math is line-count based — a wider line WRAPS in the terminal and adds an
 * unaccounted physical row, so subsequent frames drift and the transcript
 * duplicates on scroll. See packages/tui/test/regression-narrow-editor-scroll-indicator.test.ts.
 *
 * The attachment strip draws box borders, CJK-width-safe padding, half-block
 * cells wrapped in SGR sequences, and an emoji fallback label — all classic
 * width-mismeasurement sources.
 */

function makeStoreWithAttachments(count: number): AttachmentStore {
	const store = new AttachmentStore();
	// 64×48 header claims; pixel data is irrelevant for width invariants.
	for (let i = 0; i < count; i += 1) {
		store.put(pngBytes(i), "clipboard");
	}
	return store;
}

function pngBytes(seed = 0): Uint8Array {
	const bytes = new Uint8Array(56);
	[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((value, index) => {
		bytes[index] = value;
	});
	const view = new DataView(bytes.buffer);
	view.setUint32(16, 64);
	view.setUint32(20, 48);
	bytes[30] = seed; // unique payload → distinct sha256 → no store dedupe
	return bytes;
}

const WIDTHS = [20, 21, 22, 25, 31, 40, 47, 50, 55, 60, 79, 80, 81, 100, 120, 160, 200];

describe("attachment strip width invariants (scroll-drift regression)", () => {
	beforeEach(() => {
		resetAttachmentDecodeCache();
	});

	it("keeps every rendered line within the given width at all sizes — before decode settles", async () => {
		for (const count of [1, 2, 3, 5]) {
			const store = makeStoreWithAttachments(count);
			const ids = store.list().map((a) => a.id);
			const strip = createAttachmentStrip(store.list(), (id) => store.getBytes(id));
			for (const width of WIDTHS) {
				const lines = strip.render(width);
				lines.forEach((line, index) => {
					const rendered = visibleWidth(line);
					expect(
						rendered,
						`attachments=${count} width=${width} line=${index} overflow ${rendered} > ${width}`,
					).toBeLessThanOrEqual(width);
				});
			}
			expect(ids.length).toBe(count);
		}
	});

	it("keeps every line within width after decode settles (cache invalidated)", async () => {
		const store = makeStoreWithAttachments(2);
		const strip = createAttachmentStrip(store.list(), (id) => store.getBytes(id));
		// First paint caches fallback/pre-decode lines at some width.
		strip.render(80);
		// Allow the async decode loop to settle and invalidate the cache.
		await new Promise((resolve) => setTimeout(resolve, 25));
		for (const width of WIDTHS) {
			const lines = strip.render(width);
			lines.forEach((line, index) => {
				expect(visibleWidth(line), `post-decode width=${width} line=${index}`).toBeLessThanOrEqual(width);
			});
		}
	});

	it("keeps a constant row count across widths so viewport math cannot drift", async () => {
		const store = makeStoreWithAttachments(2);
		const strip = createAttachmentStrip(store.list(), (id) => store.getBytes(id));
		strip.render(80);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const counts = WIDTHS.map((width) => strip.render(width).length);
		expect(new Set(counts).size).toBe(1);
	});
});
