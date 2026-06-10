import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type CompactionPreparation, type CompactionResult, estimateTokens } from "../src/compaction/compaction";
import { createCompactionSummaryMessage, defaultConvertToLlm } from "../src/compaction/messages";
import {
	getPreservedSnapcompactArchive,
	normalizeForSnapcompact,
	renderSnapcompactFrame,
	SNAPCOMPACT_FRAME_TOKEN_ESTIMATE,
	SNAPCOMPACT_PRESERVE_KEY,
	type SnapcompactArchive,
	snapcompactCompact,
	snapcompactGeometry,
} from "../src/compaction/snapcompact";
import { createFileOps } from "../src/compaction/utils";
import { createAssistantMessage, createUserMessage } from "./helpers";

// Small frames keep render time negligible: 320px → 64 cols x 40 rows = 2560 chars.
const TEST_FRAME_SIZE = 320;

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			createUserMessage("Fix the login bug. The token expires too early!"),
			createAssistantMessage([{ type: "text", text: "Fixed the TTL comparison in src/login.ts." }]),
		],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 99000,
		previousSummary: undefined,
		previousPreserveData: undefined,
		fileOps: createFileOps(),
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		...overrides,
	};
}

interface DecodedPng {
	width: number;
	height: number;
	colorType: number;
	/** Palette indices, one byte per pixel (filter bytes stripped). */
	pixels: Uint8Array;
}

/** Minimal PNG reader for the encoder's own output (indexed, filter None). */
function decodePng(png: Uint8Array): DecodedPng {
	expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let pos = 8;
	let width = 0;
	let height = 0;
	let colorType = -1;
	let depth = 0;
	const idatParts: Uint8Array[] = [];
	while (pos < png.length) {
		const length = view.getUint32(pos);
		const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
		const data = png.subarray(pos + 8, pos + 8 + length);
		if (type === "IHDR") {
			width = view.getUint32(pos + 8);
			height = view.getUint32(pos + 12);
			depth = data[8];
			colorType = data[9];
		} else if (type === "IDAT") {
			idatParts.push(data);
		}
		pos += 12 + length;
	}
	let idatLength = 0;
	for (const part of idatParts) idatLength += part.length;
	const idat = new Uint8Array(idatLength);
	let offset = 0;
	for (const part of idatParts) {
		idat.set(part, offset);
		offset += part.length;
	}
	// Strip the zlib envelope (2-byte header + trailing Adler-32).
	const raw = Bun.inflateSync(idat.subarray(2, idat.length - 4));
	const rowBytes = depth === 4 ? Math.ceil(width / 2) : width;
	expect(raw.length).toBe(height * (rowBytes + 1));
	const pixels = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		expect(raw[y * (rowBytes + 1)]).toBe(0); // filter byte: None
		const row = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
		if (depth === 4) {
			for (let x = 0; x < width; x++) {
				const byte = row[x >> 1];
				pixels[y * width + x] = x % 2 === 0 ? byte >> 4 : byte & 0xf;
			}
		} else {
			pixels.set(row, y * width);
		}
	}
	return { width, height, colorType, pixels };
}

describe("normalizeForSnapcompact", () => {
	it("collapses whitespace runs and folds non-Latin-1 to ASCII", () => {
		expect(normalizeForSnapcompact("a\n\n\tb   c\r\nd")).toBe("a b c d");
		expect(normalizeForSnapcompact("x → y ✓ “quoted” — em…")).toBe(`x -> y v "quoted" - em...`);
		expect(normalizeForSnapcompact("café größe")).toBe("café größe"); // Latin-1 has glyphs
		expect(normalizeForSnapcompact("box │─┌ emoji 🎞")).toBe("box |-+ emoji ?");
	});
});

describe("renderSnapcompactFrame", () => {
	it("produces an indexed PNG of the declared geometry with sentence-cycled ink", () => {
		const geometry = snapcompactGeometry(TEST_FRAME_SIZE);
		expect(geometry).toEqual({ cols: 64, rows: 40, capacity: 2560 });

		const frame = renderSnapcompactFrame("First sentence here. Second one differs.", TEST_FRAME_SIZE);
		expect(frame.cols).toBe(64);
		expect(frame.rows).toBe(40);
		expect(frame.chars).toBe(40);

		const decoded = decodePng(frame.png);
		expect(decoded.width).toBe(TEST_FRAME_SIZE);
		expect(decoded.height).toBe(TEST_FRAME_SIZE);
		expect(decoded.colorType).toBe(3); // indexed color

		// Two sentences → glyphs printed in ink 1 then ink 2; background stays 0.
		const used = new Set(decoded.pixels);
		expect(used.has(1)).toBe(true);
		expect(used.has(2)).toBe(true);
		expect(used.has(3)).toBe(false);
	});

	it("caps printed characters at frame capacity", () => {
		const { capacity } = snapcompactGeometry(TEST_FRAME_SIZE);
		const frame = renderSnapcompactFrame("x".repeat(capacity + 500), TEST_FRAME_SIZE);
		expect(frame.chars).toBe(capacity);
	});
});

describe("snapcompactCompact", () => {
	it("archives history onto frames with a self-describing summary", async () => {
		const fileOps = createFileOps();
		fileOps.read.add("src/auth.ts");
		fileOps.edited.add("src/login.ts");
		const result = await snapcompactCompact(makePreparation({ fileOps }), { frameSize: TEST_FRAME_SIZE });

		expect(result.firstKeptEntryId).toBe("kept-1");
		expect(result.tokensBefore).toBe(99000);
		// Reading instructions reflect the actual grid geometry.
		expect(result.summary).toContain("64 characters per row");
		expect(result.summary).toContain("snapcompact frame");
		// File operations are upserted like every other compaction summary.
		expect(result.summary).toContain("<read-files>");
		expect(result.summary).toContain("src/login.ts");
		expect(result.shortSummary).toContain("snapcompact frame");

		const archive = getPreservedSnapcompactArchive(result.preserveData);
		expect(archive).toBeDefined();
		expect(archive?.frames.length).toBe(1);
		expect(archive?.frames[0].mimeType).toBe("image/png");
		expect(archive?.frames[0].chars).toBe(archive?.totalChars);
		expect(archive?.truncatedChars).toBe(0);
		// Frame data round-trips as a decodable PNG.
		const decoded = decodePng(Buffer.from(archive?.frames[0].data ?? "", "base64"));
		expect(decoded.width).toBe(TEST_FRAME_SIZE);
	});

	it("splits oversized history across frames and evicts beyond the budget", async () => {
		const { capacity } = snapcompactGeometry(TEST_FRAME_SIZE);
		// Sentences avoid whitespace collapse shrinking the payload below 2.5 frames.
		const longText = "Important fact number one. ".repeat(Math.ceil((capacity * 2.5) / 28));
		const result = await snapcompactCompact(makePreparation({ messagesToSummarize: [createUserMessage(longText)] }), {
			frameSize: TEST_FRAME_SIZE,
			maxFrames: 2,
		});
		const archive = getPreservedSnapcompactArchive(result.preserveData);
		expect(archive?.frames.length).toBe(2);
		expect(archive?.truncatedChars).toBeGreaterThan(0);
		expect(result.summary).toContain("dropped");
	});

	it("evicts the oldest unpinned frames, keeping the session-head frame alive", async () => {
		let previous: CompactionResult | undefined;
		let headFrameData = "";
		let secondFrameData = "";
		for (let pass = 1; pass <= 4; pass++) {
			previous = await snapcompactCompact(
				makePreparation({
					messagesToSummarize: [createUserMessage(`Distinct turn number ${pass}.`)],
					previousSummary: previous?.summary,
					previousPreserveData: previous?.preserveData,
				}),
				{ frameSize: TEST_FRAME_SIZE, maxFrames: 3 },
			);
			const archive = getPreservedSnapcompactArchive(previous.preserveData);
			if (pass === 1) headFrameData = archive?.frames[0].data ?? "";
			if (pass === 2) secondFrameData = archive?.frames[1].data ?? "";
		}
		const final = getPreservedSnapcompactArchive(previous?.preserveData);
		expect(final?.frames.length).toBe(3);
		// The head frame (original request) is pinned through every eviction;
		// the archive fades from the middle out.
		expect(final?.frames[0].data).toBe(headFrameData);
		expect(final?.frames.some(frame => frame.data === secondFrameData)).toBe(false);
		expect(final?.truncatedChars).toBeGreaterThan(0);
	});

	it("includes the previous text summary when the prior compaction was not snapcompact", async () => {
		const result = await snapcompactCompact(
			makePreparation({ previousSummary: "Older context: project scaffolding done." }),
			{ frameSize: TEST_FRAME_SIZE },
		);
		expect(result.summary).toContain("[Summary of earlier history]");
	});

	it("carries previous frames forward and strips the OpenAI remote payload", async () => {
		const first = await snapcompactCompact(makePreparation(), { frameSize: TEST_FRAME_SIZE });
		const firstArchive = getPreservedSnapcompactArchive(first.preserveData);

		const second = await snapcompactCompact(
			makePreparation({
				messagesToSummarize: [createUserMessage("A new turn happened after the first compaction.")],
				previousSummary: first.summary,
				previousPreserveData: {
					...first.preserveData,
					openaiRemoteCompaction: { provider: "openai", replacementHistory: [] },
					appKey: "kept",
				},
			}),
			{ frameSize: TEST_FRAME_SIZE },
		);

		const archive = getPreservedSnapcompactArchive(second.preserveData);
		expect(archive?.frames.length).toBe(2);
		// Oldest frame rides along unchanged, new frame appended after it.
		expect(archive?.frames[0].data).toBe(firstArchive?.frames[0].data ?? "");
		// Previous archive present → previous summary is snapcompact boilerplate, not re-archived.
		expect(second.summary).not.toContain("[Summary of earlier history]");
		expect(second.preserveData?.openaiRemoteCompaction).toBeUndefined();
		expect(second.preserveData?.appKey).toBe("kept");
	});
});

describe("compaction summary message with snapcompact frames", () => {
	const images: ImageContent[] = [
		{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		{ type: "image", data: "ZmFrZTI=", mimeType: "image/png" },
	];

	it("estimateTokens charges per attached frame", () => {
		const bare = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString());
		const withFrames = createCompactionSummaryMessage(
			"summary text",
			1000,
			new Date().toISOString(),
			undefined,
			undefined,
			images,
		);
		expect(estimateTokens(withFrames) - estimateTokens(bare)).toBe(2 * SNAPCOMPACT_FRAME_TOKEN_ESTIMATE);
	});

	it("defaultConvertToLlm appends frames as image blocks after the summary text", () => {
		const message = createCompactionSummaryMessage(
			"the snapcompact archive",
			1000,
			new Date().toISOString(),
			undefined,
			undefined,
			images,
		);
		const [converted] = defaultConvertToLlm([message]);
		expect(converted.role).toBe("user");
		const content = converted.content as Array<{ type: string; text?: string; data?: string }>;
		expect(content.length).toBe(3);
		expect(content[0].type).toBe("text");
		expect(content[0].text).toContain("the snapcompact archive");
		expect(content[1]).toEqual(images[0]);
		expect(content[2]).toEqual(images[1]);
	});

	it("getPreservedSnapcompactArchive rejects malformed payloads", () => {
		expect(getPreservedSnapcompactArchive(undefined)).toBeUndefined();
		expect(getPreservedSnapcompactArchive({ [SNAPCOMPACT_PRESERVE_KEY]: "nope" })).toBeUndefined();
		expect(getPreservedSnapcompactArchive({ [SNAPCOMPACT_PRESERVE_KEY]: { frames: [] } })).toBeUndefined();
		const valid: SnapcompactArchive = {
			frames: [{ data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 10 }],
			totalChars: 10,
			truncatedChars: 0,
		};
		expect(getPreservedSnapcompactArchive({ [SNAPCOMPACT_PRESERVE_KEY]: valid })).toEqual(valid);
	});
});
