/**
 * In-memory content-addressed store for prompt image attachments.
 *
 * Owns the raw bytes so the TUI draft survives editor swaps (extension editor,
 * model selector) and only releases entries after the prompt is accepted.
 * Raw base64 never enters logs or journals — materialization happens at the
 * last step, right before `session.prompt(text, { images })`.
 */

import type { ImageContent } from "omk-ai";
import {
	createPromptImageAttachment,
	PROMPT_ATTACHMENT_LIMITS,
	PromptAttachmentError,
	type PromptAttachmentSource,
	type PromptImageAttachment,
} from "./prompt-attachment.ts";

interface StoredAttachment {
	readonly attachment: PromptImageAttachment;
	readonly bytes: Uint8Array;
}

export interface AttachmentStoreLimits {
	maxAttachments?: number;
	maxImageBytes?: number;
	maxPixels?: number;
	maxDraftBytes?: number;
}

export class AttachmentStore {
	private readonly entries = new Map<string, StoredAttachment>();
	private readonly maxAttachments: number;
	private readonly maxImageBytes: number;
	private readonly maxPixels: number;
	private readonly maxDraftBytes: number;

	constructor(limits: AttachmentStoreLimits = {}) {
		this.maxAttachments = limits.maxAttachments ?? PROMPT_ATTACHMENT_LIMITS.maxAttachments;
		this.maxImageBytes = limits.maxImageBytes ?? PROMPT_ATTACHMENT_LIMITS.maxImageBytes;
		this.maxPixels = limits.maxPixels ?? PROMPT_ATTACHMENT_LIMITS.maxPixels;
		this.maxDraftBytes = limits.maxDraftBytes ?? PROMPT_ATTACHMENT_LIMITS.maxDraftBytes;
	}

	/** Validate + store bytes; returns the attachment record. Throws PromptAttachmentError. */
	put(bytes: Uint8Array, source: PromptAttachmentSource): PromptImageAttachment {
		if (this.entries.size >= this.maxAttachments) {
			throw new PromptAttachmentError("limit-reached", `Attachment limit reached (${this.maxAttachments}).`);
		}
		const draftBytes = this.totalBytes() + bytes.length;
		if (draftBytes > this.maxDraftBytes) {
			throw new PromptAttachmentError(
				"too-large",
				`Draft would exceed ${(this.maxDraftBytes / (1024 * 1024)).toFixed(0)} MiB of attachments.`,
			);
		}
		const attachment = createPromptImageAttachment(bytes, source, {
			maxImageBytes: this.maxImageBytes,
			maxPixels: this.maxPixels,
		});
		// Content-addressed dedupe: identical bytes reuse one entry.
		const existing = [...this.entries.values()].find((entry) => entry.attachment.sha256 === attachment.sha256);
		if (existing) return existing.attachment;
		this.entries.set(attachment.id, { attachment, bytes });
		return attachment;
	}

	get(id: string): PromptImageAttachment | undefined {
		return this.entries.get(id)?.attachment;
	}

	getBytes(id: string): Uint8Array | undefined {
		return this.entries.get(id)?.bytes;
	}

	remove(id: string): boolean {
		return this.entries.delete(id);
	}

	clear(): void {
		this.entries.clear();
	}

	list(): PromptImageAttachment[] {
		return [...this.entries.values()].map((entry) => entry.attachment);
	}

	totalBytes(): number {
		let total = 0;
		for (const entry of this.entries.values()) total += entry.bytes.length;
		return total;
	}

	/**
	 * Materialize attachments into `ImageContent[]` for
	 * `session.prompt(text, { images })`. Missing ids throw — callers snapshot
	 * ids at submit time and must not send half-removed drafts.
	 */
	materializeImages(ids: readonly string[]): ImageContent[] {
		return ids.map((id) => {
			const entry = this.entries.get(id);
			if (!entry) throw new PromptAttachmentError("empty", `Attachment ${id} is no longer available.`);
			return {
				type: "image" as const,
				data: Buffer.from(entry.bytes).toString("base64"),
				mimeType: entry.attachment.mimeType,
			};
		});
	}
}
