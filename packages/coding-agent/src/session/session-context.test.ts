import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { CompactionSummaryMessage } from "./messages";
import { buildSessionContext } from "./session-context";
import type { SessionEntry } from "./session-entries";

const timestamp = "2026-07-09T00:00:00.000Z";

const compactedEntries = [
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "before compaction" }], timestamp: 1 },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "m1",
		timestamp,
		summary: "summary",
		firstKeptEntryId: "m1",
		tokensBefore: 123,
		preserveData: {
			[snapcompact.PRESERVE_KEY]: {
				frames: [{ data: "base64-frame", mimeType: "image/png", cols: 10, rows: 10, chars: 100 }],
				totalChars: 100,
				truncatedChars: 0,
				textHead: "head",
				textTail: "tail",
			},
		},
	},
	{
		type: "message",
		id: "m2",
		parentId: "c1",
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "after compaction" }], timestamp: 2 },
	},
] satisfies SessionEntry[];

function compactionSummary(messages: AgentMessage[]): CompactionSummaryMessage {
	const summary = messages.find(
		(message): message is CompactionSummaryMessage => message.role === "compactionSummary",
	);
	if (!summary) throw new Error("Expected a compaction summary message");
	return summary;
}

describe("buildSessionContext snapcompact archives", () => {
	it("omits snapcompact archive blocks from collapsed transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});

		const summary = compactionSummary(context.messages);

		expect(summary.images).toBeUndefined();
		expect(summary.blocks).toBeUndefined();
	});

	it("keeps snapcompact archive blocks in full transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, { transcript: true });

		const summary = compactionSummary(context.messages);

		expect(summary.images?.map(image => image.data)).toEqual(["base64-frame"]);
		expect(summary.blocks?.map(block => block.type)).toEqual(["text", "image", "text"]);
	});

	it("keeps snapcompact archive blocks in provider context summaries", () => {
		const context = buildSessionContext(compactedEntries);

		const summary = compactionSummary(context.messages);

		expect(summary.images?.map(image => image.data)).toEqual(["base64-frame"]);
		expect(summary.blocks?.map(block => block.type)).toEqual(["text", "image", "text"]);
	});
});
