import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { FileEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveBlobRefsInEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";

type ImagePayload = { data: string; mimeType: string; type?: "image" };
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type ToolResultEntry = Omit<SessionMessageEntry, "message"> & { message: ToolResultMessage };

const text = (value: string): TextContent => ({ type: "text", text: value });
const png = (data: string): ImageContent => ({ type: "image", data, mimeType: "image/png" });
const payload = (data: string): ImagePayload => ({ data, mimeType: "image/png" });

function messageEntry(message: ToolResultMessage): ToolResultEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message,
	};
}

describe("session image persistence", () => {
	it("externalizes and resolves content images and tool detail image payloads", async () => {
		using tempDir = TempDir.createSync("@session-image-persistence-");
		const blobStore = new BlobStore(tempDir.path());
		const contentImageData = Buffer.alloc(1500, 1).toString("base64");
		const generatedImageData = Buffer.alloc(1500, 2).toString("base64");
		const typedDetailImageData = Buffer.alloc(1500, 3).toString("base64");

		const original = messageEntry({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "generate_image",
			content: [text("generated"), png(contentImageData)],
			details: {
				images: [payload(generatedImageData), png(typedDetailImageData)],
			},
			isError: false,
			timestamp: Date.now(),
		});

		const persisted = prepareEntryForPersistence(original, blobStore) as ToolResultEntry;
		const persistedContentImage = persisted.message.content.find(
			(block): block is ImageContent => block.type === "image",
		);
		const persistedDetails = persisted.message.details as { images: ImagePayload[] };

		expect(persistedContentImage).toBeDefined();
		expect(isBlobRef(persistedContentImage?.data ?? "")).toBe(true);
		expect(persistedDetails.images).toHaveLength(2);
		expect(persistedDetails.images.every(image => isBlobRef(image.data))).toBe(true);

		const loaded: FileEntry[] = [structuredClone(persisted)];
		await resolveBlobRefsInEntries(loaded, blobStore);
		const resolved = loaded[0] as ToolResultEntry;
		const resolvedContentImage = resolved.message.content.find(
			(block): block is ImageContent => block.type === "image",
		);
		const resolvedDetails = resolved.message.details as { images: ImagePayload[] };

		expect(resolvedContentImage?.data).toBe(contentImageData);
		expect(resolvedDetails.images[0]?.data).toBe(generatedImageData);
		expect(resolvedDetails.images[1]?.data).toBe(typedDetailImageData);
	});

	it("externalizes and restores native Responses images in assistant content and provider history", async () => {
		using tempDir = TempDir.createSync("@session-native-image-persistence-");
		const blobStore = new BlobStore(tempDir.path());
		const data = Buffer.alloc(1500, 4).toString("base64");
		const original: SessionMessageEntry = {
			type: "message",
			id: "entry-native-image",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [png(data)],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-image-test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: "openai",
					items: [{ type: "image_generation_call", id: "ig_1", status: "completed", result: data }],
				},
				timestamp: Date.now(),
			},
		};

		const persisted = prepareEntryForPersistence(original, blobStore);
		if (persisted.type !== "message" || persisted.message.role !== "assistant") {
			throw new Error("expected persisted assistant message");
		}
		const persistedImage = persisted.message.content.find(block => block.type === "image");
		const persistedItem = persisted.message.providerPayload?.items[0];
		if (!persistedItem || typeof persistedItem.result !== "string") {
			throw new Error("expected persisted image generation item");
		}
		expect(isBlobRef(persistedImage?.data ?? "")).toBe(true);
		expect(isBlobRef(persistedItem.result)).toBe(true);

		const loaded: FileEntry[] = [structuredClone(persisted)];
		await resolveBlobRefsInEntries(loaded, blobStore);
		const resolved = loaded[0];
		if (resolved?.type !== "message" || resolved.message.role !== "assistant") {
			throw new Error("expected resolved assistant message");
		}
		const resolvedImage = resolved.message.content.find(block => block.type === "image");
		const resolvedItem = resolved.message.providerPayload?.items[0];
		expect(resolvedImage?.data).toBe(data);
		expect(resolvedItem?.result).toBe(data);
	});
});
