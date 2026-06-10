import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { SNAPCOMPACT_FRAME_TOKEN_ESTIMATE } from "@oh-my-pi/snapcompact";
import { estimateTokens } from "../src/compaction/compaction";
import { createCompactionSummaryMessage, defaultConvertToLlm } from "../src/compaction/messages";

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
});
