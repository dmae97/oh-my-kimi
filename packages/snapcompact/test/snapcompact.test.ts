import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, Usage } from "@oh-my-pi/pi-ai";
import {
	createSnapcompactFileOps,
	getPreservedSnapcompactArchive,
	isSnapcompactShape,
	normalizeForSnapcompact,
	renderSnapcompactFrame,
	resolveSnapcompactShape,
	SNAPCOMPACT_DIM_OFF,
	SNAPCOMPACT_DIM_ON,
	SNAPCOMPACT_PRESERVE_KEY,
	SNAPCOMPACT_SHAPES,
	type SnapcompactArchive,
	type SnapcompactCompactionPreparation,
	type SnapcompactCompactionResult,
	serializeSnapcompactConversation,
	snapcompactCompact,
	snapcompactGeometry,
	snapcompactImages,
} from "../src";

// Small frames keep render time negligible. Legacy 5x8 shape: 320px → 64 cols
// x 40 rows = 2560 chars. Default (anthropic 8x8r-bw): 40 cols x 20 rows = 800.
const TEST_FRAME_SIZE = 320;

function createUserMessage(content: string): Message {
	return { role: "user", content, timestamp: 0 };
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function createAssistantMessage(content: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function createToolResultMessage(text: string): Message {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function makePreparation(
	overrides: Partial<SnapcompactCompactionPreparation<Message>> = {},
): SnapcompactCompactionPreparation<Message> {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			createUserMessage("Fix the login bug. The token expires too early!"),
			createAssistantMessage([{ type: "text", text: "Fixed the TTL comparison in src/login.ts." }]),
		],
		turnPrefixMessages: [],
		tokensBefore: 99000,
		previousSummary: undefined,
		previousPreserveData: undefined,
		fileOps: createSnapcompactFileOps(),
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

describe("shape resolution", () => {
	it("maps provider APIs to their eval-winning shapes", () => {
		expect(resolveSnapcompactShape("anthropic-messages")).toBe(SNAPCOMPACT_SHAPES.anthropic);
		expect(resolveSnapcompactShape("openai-responses")).toBe(SNAPCOMPACT_SHAPES.openaiDense);
		expect(resolveSnapcompactShape("azure-openai-responses")).toBe(SNAPCOMPACT_SHAPES.openaiDense);
		expect(resolveSnapcompactShape("google-generative-ai")).toBe(SNAPCOMPACT_SHAPES.google);
		// Unknown and absent APIs fall back to the refusal-robust plain shape.
		expect(resolveSnapcompactShape("some-future-api")).toBe(SNAPCOMPACT_SHAPES.anthropic);
		expect(resolveSnapcompactShape(undefined)).toBe(SNAPCOMPACT_SHAPES.anthropic);
	});

	it("recognizes complete shape overrides and rejects malformed ones", () => {
		expect(isSnapcompactShape(SNAPCOMPACT_SHAPES.openaiDense)).toBe(true);
		expect(isSnapcompactShape({ ...SNAPCOMPACT_SHAPES.openaiDense, cellWidth: 0 })).toBe(false);
		expect(isSnapcompactShape({ ...SNAPCOMPACT_SHAPES.openaiDense, variant: "color" })).toBe(false);
		expect(isSnapcompactShape({ ...SNAPCOMPACT_SHAPES.openaiDense, imageDetail: "original" })).toBe(true);
	});

	it("snapcompactImages forwards the per-frame detail hint", () => {
		const archive: SnapcompactArchive = {
			frames: [
				{ data: "ZmFrZQ==", mimeType: "image/png", cols: 10, rows: 10, chars: 5, detail: "original" },
				{ data: "ZmFrZTI=", mimeType: "image/png", cols: 10, rows: 10, chars: 5 },
			],
			totalChars: 10,
			truncatedChars: 0,
		};
		const [withDetail, without] = snapcompactImages(archive);
		expect(withDetail.detail).toBe("original");
		expect("detail" in without).toBe(false);
	});
});

describe("renderSnapcompactFrame", () => {
	it("produces an indexed PNG of the declared geometry with sentence-cycled ink (legacy 5x8)", () => {
		const geometry = snapcompactGeometry(SNAPCOMPACT_SHAPES.legacy, TEST_FRAME_SIZE);
		expect(geometry).toEqual({ cols: 64, rows: 40, capacity: 2560 });

		const frame = renderSnapcompactFrame(
			"First sentence here. Second one differs.",
			SNAPCOMPACT_SHAPES.legacy,
			TEST_FRAME_SIZE,
		);
		expect(frame.cols).toBe(64);
		expect(frame.rows).toBe(40);
		expect(frame.chars).toBe(40);

		const decoded = decodePng(Buffer.from(frame.data, "base64"));
		expect(decoded.width).toBe(TEST_FRAME_SIZE);
		expect(decoded.height).toBe(TEST_FRAME_SIZE);
		expect(decoded.colorType).toBe(3); // indexed color

		// Two sentences → glyphs printed in ink 1 then ink 2; background stays 0.
		const used = new Set(decoded.pixels);
		expect(used.has(1)).toBe(true);
		expect(used.has(2)).toBe(true);
		expect(used.has(3)).toBe(false);
	});

	it("renders the anthropic shape with doubled lines, black ink, and highlight bands", () => {
		const geometry = snapcompactGeometry(SNAPCOMPACT_SHAPES.anthropic, TEST_FRAME_SIZE);
		expect(geometry).toEqual({ cols: 40, rows: 20, capacity: 800 });

		const frame = renderSnapcompactFrame("Hello world. Again.", SNAPCOMPACT_SHAPES.anthropic, TEST_FRAME_SIZE);
		const decoded = decodePng(Buffer.from(frame.data, "base64"));
		expect(decoded.colorType).toBe(3);
		const used = new Set(decoded.pixels);
		expect(used.has(7)).toBe(true); // black bw ink
		expect(used.has(8)).toBe(true); // repeat highlight band
		expect(used.has(1)).toBe(false); // no sentence hues in bw
	});

	it("renders the openai stretch shape as truecolor RGB", () => {
		const frame = renderSnapcompactFrame("Hello world.", SNAPCOMPACT_SHAPES.openaiDense, TEST_FRAME_SIZE);
		// IHDR color type byte: 2 = truecolor RGB (anti-aliased stretch output).
		expect(Buffer.from(frame.data, "base64")[25]).toBe(2);
		expect(frame.cols).toBe(Math.floor(TEST_FRAME_SIZE / 6));
	});

	it("caps printed characters at frame capacity", () => {
		const { capacity } = snapcompactGeometry(SNAPCOMPACT_SHAPES.legacy, TEST_FRAME_SIZE);
		const frame = renderSnapcompactFrame("x".repeat(capacity + 500), SNAPCOMPACT_SHAPES.legacy, TEST_FRAME_SIZE);
		expect(frame.chars).toBe(capacity);
	});
});

describe("serializeSnapcompactConversation", () => {
	it("truncates oversized tool results keeping head and tail", () => {
		const text = `HEAD-${"x".repeat(5000)}-TAIL`;
		const out = serializeSnapcompactConversation([createToolResultMessage(text)]);
		// Default cap 2000 at 0.6 head ratio: 1200 head + 800 tail survive.
		expect(out).toContain("[Tool result]: ");
		expect(out).toContain("HEAD-");
		expect(out).toContain("[... 3010 chars elided ...]");
		expect(out.endsWith(`-TAIL${SNAPCOMPACT_DIM_OFF}`)).toBe(true);
	});

	it("honors configured budgets; Infinity disables a cap", () => {
		const text = "a".repeat(100);
		const tight = serializeSnapcompactConversation([createToolResultMessage(text)], {
			toolResultMaxChars: 10,
			truncateHeadRatio: 0.5,
		});
		expect(tight).toContain("[... 90 chars elided ...]");
		const off = serializeSnapcompactConversation([createToolResultMessage(text)], {
			toolResultMaxChars: Number.POSITIVE_INFINITY,
		});
		expect(off).toContain(text);
	});

	it("caps oversized tool-call argument values without touching small ones", () => {
		const out = serializeSnapcompactConversation([
			createAssistantMessage([
				{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts", content: "y".repeat(3000) } },
			]),
		]);
		// JSON-encoded content is 3002 chars; per-value cap 500 elides 2502.
		expect(out).toContain('write(path="a.ts", content=');
		expect(out).toContain("[... 2502 chars elided ...]");
	});

	it("caps the whole serialized argument list per call", () => {
		const args: Record<string, unknown> = {};
		for (let i = 0; i < 10; i++) args[`arg${i}`] = "z".repeat(400);
		const out = serializeSnapcompactConversation([
			createAssistantMessage([{ type: "toolCall", id: "c1", name: "tool", arguments: args }]),
		]);
		expect(out).toContain("arg0=");
		expect(out).toContain("chars elided");
		// 10 values x ~400 chars collapse to the 2000-char call budget plus markers.
		expect(out.length).toBeLessThan(2200);
	});

	it("wraps tool results in dim toggles by default and strips stray toggles from content", () => {
		const out = serializeSnapcompactConversation([
			createUserMessage(`hello ${SNAPCOMPACT_DIM_ON}world`),
			createToolResultMessage("ok"),
		]);
		expect(out).toContain(`[Tool result]: ${SNAPCOMPACT_DIM_ON}ok${SNAPCOMPACT_DIM_OFF}`);
		// A stray toggle in user content cannot forge a dim span.
		expect(out).toContain("[User]: hello world");
	});

	it("omits dim toggles when dimToolResults is false", () => {
		const out = serializeSnapcompactConversation([createToolResultMessage("ok")], { dimToolResults: false });
		expect(out).toBe("[Tool result]: ok");
	});
});

describe("snapcompactCompact", () => {
	it("archives history onto frames with a self-describing summary", async () => {
		const fileOps = createSnapcompactFileOps();
		fileOps.read.add("src/auth.ts");
		fileOps.edited.add("src/login.ts");
		const result = await snapcompactCompact(makePreparation({ fileOps }), { frameSize: TEST_FRAME_SIZE });

		expect(result.firstKeptEntryId).toBe("kept-1");
		expect(result.tokensBefore).toBe(99000);
		// Reading instructions reflect the default (anthropic 8x8r-bw) shape.
		expect(result.summary).toContain("40 characters per row");
		expect(result.summary).toContain("printed twice");
		expect(result.summary).toContain("plain black ink");
		expect(result.summary).toContain("snapcompact frame");
		// File operations are upserted like every other compaction summary:
		// one grouped <files> tree with per-file access markers.
		expect(result.summary).toContain("<files>\n# src/\nauth.ts (Read)\nlogin.ts (Write)\n</files>");
		expect(result.shortSummary).toContain("snapcompact frame");

		const archive = getPreservedSnapcompactArchive(result.preserveData);
		expect(archive).toBeDefined();
		expect(archive?.frames.length).toBe(1);
		expect(archive?.frames[0].mimeType).toBe("image/png");
		expect(archive?.frames[0].chars).toBe(archive?.totalChars);
		expect(archive?.frames[0].font).toBe("8x8");
		expect(archive?.frames[0].variant).toBe("bw");
		expect(archive?.frames[0].lineRepeat).toBe(2);
		expect(archive?.truncatedChars).toBe(0);
		// Frame data round-trips as a decodable PNG.
		const decoded = decodePng(Buffer.from(archive?.frames[0].data ?? "", "base64"));
		expect(decoded.width).toBe(TEST_FRAME_SIZE);
	});

	it("prints tool results in dim gray ink, persisting the span across frame boundaries", async () => {
		// Anthropic shape at 320px holds 800 chars/frame; a 1650-char tool
		// result spans three frames, so the reopened span must dim in each.
		const result = await snapcompactCompact(
			makePreparation({
				messagesToSummarize: [createUserMessage("Run the suite."), createToolResultMessage("FAIL ".repeat(330))],
			}),
			{ frameSize: TEST_FRAME_SIZE },
		);
		const archive = getPreservedSnapcompactArchive(result.preserveData);
		expect(archive?.frames.length).toBeGreaterThanOrEqual(2);
		for (const frame of archive?.frames ?? []) {
			const decoded = decodePng(Buffer.from(frame.data, "base64"));
			// Palette index 9 is the dim tool-output ink.
			expect(new Set(decoded.pixels).has(9)).toBe(true);
		}
		// Conversation text outside the span stays in black bw ink (frame 1).
		const first = decodePng(Buffer.from(archive?.frames[0].data ?? "", "base64"));
		expect(new Set(first.pixels).has(7)).toBe(true);
		expect(result.summary).toContain("dim gray ink");
	});

	it("keeps frames free of dim ink when dimToolResults is false", async () => {
		const result = await snapcompactCompact(
			makePreparation({
				messagesToSummarize: [createUserMessage("Run."), createToolResultMessage("all good")],
			}),
			{ frameSize: TEST_FRAME_SIZE, dimToolResults: false },
		);
		const archive = getPreservedSnapcompactArchive(result.preserveData);
		const decoded = decodePng(Buffer.from(archive?.frames[0].data ?? "", "base64"));
		expect(new Set(decoded.pixels).has(9)).toBe(false);
		expect(result.summary).not.toContain("dim gray ink");
	});

	it("splits oversized history across frames and evicts beyond the budget", async () => {
		const { capacity } = snapcompactGeometry(SNAPCOMPACT_SHAPES.anthropic, TEST_FRAME_SIZE);
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
		let previous: SnapcompactCompactionResult | undefined;
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

	it("flags mixed shapes when merged frames disagree with the active shape", async () => {
		const first = await snapcompactCompact(makePreparation(), {
			frameSize: TEST_FRAME_SIZE,
			shape: SNAPCOMPACT_SHAPES.legacy,
		});
		const second = await snapcompactCompact(
			makePreparation({
				messagesToSummarize: [createUserMessage("Another turn after a provider switch.")],
				previousSummary: first.summary,
				previousPreserveData: first.preserveData,
			}),
			{ frameSize: TEST_FRAME_SIZE, model: { api: "anthropic-messages" } },
		);
		expect(second.summary).toContain("Older frames may use a different font");
		// Same-shape merges stay silent.
		expect(first.summary).not.toContain("Older frames may use a different font");
	});
});

describe("archive helpers", () => {
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
