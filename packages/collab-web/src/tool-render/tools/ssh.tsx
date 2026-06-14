/** `ssh` — remote command execution on a configured SSH host. */
import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Note, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import {
	detailsRecord,
	isRecord,
	normalizeWs,
	num,
	replaceTabs,
	resultTextOf,
	shortenPath,
	str,
	truncate,
} from "../util";

/** Subset of the coding-agent `TruncationMeta` we surface. */
interface TruncationInfo {
	totalLines: number | null;
	outputLines: number | null;
	artifactId: string | null;
}

function truncationOf(result: ToolRenderProps["result"]): TruncationInfo | null {
	const meta = detailsRecord(result)?.meta;
	if (!isRecord(meta) || !isRecord(meta.truncation)) return null;
	const t = meta.truncation;
	return {
		totalLines: num(t.totalLines),
		outputLines: num(t.outputLines),
		artifactId: str(t.artifactId),
	};
}

/**
 * The tool wrapper bakes a trailing `[Showing lines …]` notice into the
 * LLM-facing text. Like the TUI, drop it when we render our own styled
 * truncation note. Only called when truncation meta is present.
 */
function stripTruncationNotice(text: string): string {
	const trimmed = text.trimEnd();
	if (!trimmed.endsWith("]")) return trimmed;
	const idx = trimmed.lastIndexOf("\n[Showing ");
	if (idx >= 0) return trimmed.slice(0, idx).trimEnd();
	return trimmed.startsWith("[Showing ") && !trimmed.includes("\n") ? "" : trimmed;
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const host = str(args.host);
	const command = str(args.command);
	return (
		<>
			<Badge tone="accent">{host ?? "…"}</Badge>{" "}
			{command !== null
				? truncate(normalizeWs(command), 80)
				: args.command !== undefined && <InvalidArg what="command" />}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const host = str(args.host);
	const command = str(args.command);
	const cwd = str(args.cwd);
	const timeout = num(args.timeout);
	const trunc = truncationOf(result);
	const stripped =
		trunc !== null && result?.isError !== true ? stripTruncationNotice(resultTextOf(result).trim()) : null;
	return (
		<>
			<Badges
				items={[
					host !== null ? <Badge tone="accent">{host}</Badge> : <InvalidArg what="host" />,
					cwd !== null && <Badge>cwd {shortenPath(cwd)}</Badge>,
					timeout !== null && <Badge>timeout {timeout}s</Badge>,
				]}
			/>
			{command !== null ? (
				<div className="tv-cmd">
					<span className="tv-cmd-prompt">$</span>
					<span className="tv-cmd-text">{replaceTabs(command)}</span>
				</div>
			) : (
				<InvalidArg what="command" />
			)}
			{stripped !== null ? (
				stripped !== "" && <Output text={stripped} maxLines={12} />
			) : (
				<ResultText result={result} maxLines={12} />
			)}
			{trunc !== null && (
				<Note tone="warn">
					Output truncated
					{trunc.outputLines !== null &&
						trunc.totalLines !== null &&
						` — showing ${trunc.outputLines} of ${trunc.totalLines} lines`}
					{trunc.artifactId !== null && ` · full output at artifact://${trunc.artifactId}`}
				</Note>
			)}
		</>
	);
}

export const sshRenderer: ToolRenderer = { Summary, Body };
