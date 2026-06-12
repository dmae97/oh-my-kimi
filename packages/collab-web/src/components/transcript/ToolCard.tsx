import type { ImageContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ChevronRight, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useState } from "react";
import { messageText } from "../../lib/format";

const RESULT_CLAMP = 16 * 1024;

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running?: boolean;
	partialResult?: unknown;
}

function argDigest(args: unknown): string {
	if (args === null || args === undefined) return "";
	let text: string;
	try {
		text = typeof args === "string" ? args : (JSON.stringify(args) ?? "");
	} catch {
		text = String(args);
	}
	text = text.replace(/\s+/g, " ");
	return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

function prettyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function ClampedText({ text, className }: { text: string; className: string }): ReactNode {
	const [showAll, setShowAll] = useState(false);
	const clamped = !showAll && text.length > RESULT_CLAMP;
	return (
		<>
			<pre className={className}>{clamped ? text.slice(0, RESULT_CLAMP) : text}</pre>
			{clamped && (
				<button type="button" className="tr-more" onClick={() => setShowAll(true)}>
					show more ({text.length - RESULT_CLAMP} more chars)
				</button>
			)}
		</>
	);
}

function openImage(img: ImageContent): void {
	try {
		const bin = atob(img.data);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const url = URL.createObjectURL(new Blob([bytes], { type: img.mimeType }));
		window.open(url, "_blank", "noopener");
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	} catch {
		// undecodable image data — thumbnail already conveys the failure
	}
}

export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { name, intent, args, result, running, partialResult } = props;
	const [open, setOpen] = useState(false);

	const isError = result?.isError === true;
	const status = running ? "run" : isError ? "err" : result ? "ok" : "pending";

	const images: ImageContent[] = [];
	let resultText = "";
	if (result) {
		const textParts: string[] = [];
		for (const block of result.content) {
			switch (block.type) {
				case "text":
					textParts.push(block.text);
					break;
				case "image":
					images.push(block);
					break;
				default:
					break;
			}
		}
		resultText = textParts.join("\n");
	}
	const partialText =
		running && !result ? (typeof partialResult === "string" ? partialResult : messageText(partialResult)) : "";

	return (
		<div className={`tr-tool${isError ? " tr-tool--error" : ""}`}>
			<button type="button" className="tr-tool-head" onClick={() => setOpen(v => !v)}>
				{status === "run" ? (
					<Loader2 size={12} className="tr-tool-spin" aria-label="running" />
				) : (
					<span className={`tr-tool-dot tr-tool-dot--${status}`} />
				)}
				<span className="tr-tool-name">{name}</span>
				<span className="tr-tool-intent">{intent || argDigest(args)}</span>
				<ChevronRight size={12} className={`tr-tool-chev${open ? " tr-tool-chev--open" : ""}`} />
			</button>
			{open && (
				<div className="tr-tool-body">
					<div className="tr-tool-label">args</div>
					<pre className="tr-tool-pre">{prettyJson(args)}</pre>
					{resultText.length > 0 && (
						<>
							<div className="tr-tool-label">{isError ? "error" : "result"}</div>
							<ClampedText
								text={resultText}
								className={`tr-tool-pre tr-tool-result${isError ? " tr-tool-result--error" : ""}`}
							/>
						</>
					)}
					{images.length > 0 && (
						<div className="tr-tool-imgs">
							{images.map((img, i) => (
								<img
									key={i}
									className="tr-tool-img"
									src={`data:${img.mimeType};base64,${img.data}`}
									alt={`tool result ${i + 1}`}
									onClick={() => openImage(img)}
								/>
							))}
						</div>
					)}
				</div>
			)}
			{partialText.length > 0 && (
				<pre className="tr-tool-pre tr-tool-partial">
					{partialText.length > 2048 ? `…${partialText.slice(-2048)}` : partialText}
				</pre>
			)}
		</div>
	);
});
