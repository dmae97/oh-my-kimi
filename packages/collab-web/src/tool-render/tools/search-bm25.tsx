/** `search_tool_bm25` — BM25 tool discovery: query in, ranked tool matches out. */
import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Kv, KvGrid, Note, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

interface Bm25Match {
	name: string;
	label: string;
	description: string;
	serverName: string | null;
	score: number | null;
}

function matchOf(value: unknown): Bm25Match | null {
	if (!isRecord(value)) return null;
	const name = str(value.name) ?? "";
	const label = str(value.label) ?? name;
	if (!label) return null;
	return {
		name,
		label,
		description: str(value.description) ?? "",
		serverName: str(value.server_name),
		score: num(value.score),
	};
}

function strList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item) out.push(item);
	}
	return out;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	const limit = num(args.limit);
	const details = detailsRecord(result);
	const tools = details && Array.isArray(details.tools) ? details.tools : null;
	return (
		<>
			{query !== null ? (
				<span className="tv-pattern">{truncate(normalizeWs(query), 64) || "(empty query)"}</span>
			) : (
				<InvalidArg what="query" />
			)}
			{limit !== null && <Badge>limit:{limit}</Badge>}
			{tools && (
				<Badge tone={tools.length > 0 ? "ok" : "warn"}>
					{tools.length} match{tools.length === 1 ? "" : "es"}
				</Badge>
			)}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const query = str(details?.query) ?? str(args.query);
	const limit = num(details?.limit) ?? num(args.limit);
	const totalTools = num(details?.total_tools);
	const activated = strList(details?.activated_tools);
	const activeSelected = strList(details?.active_selected_tools);
	const matches: Bm25Match[] = [];
	if (details && Array.isArray(details.tools)) {
		for (const item of details.tools) {
			const match = matchOf(item);
			if (match) matches.push(match);
		}
	}
	return (
		<>
			<KvGrid>
				<Kv k="query">
					{query !== null ? <span className="tv-pattern">{query}</span> : <InvalidArg what="query" />}
				</Kv>
				{limit !== null && <Kv k="limit">{limit}</Kv>}
				{details && (
					<Kv k="tools">
						{matches.length} matched
						{activeSelected.length > 0 && ` · ${activeSelected.length} active`}
						{totalTools !== null && ` · ${totalTools} total`}
					</Kv>
				)}
				{activated.length > 0 && (
					<Kv k="activated">
						<Badges items={activated} />
					</Kv>
				)}
			</KvGrid>
			{details && !result?.isError && matches.length === 0 && (
				<Note tone="warn">
					{totalTools === 0 ? "No discoverable tools are currently loaded." : "No matching tools found."}
				</Note>
			)}
			{matches.length > 0 && (
				<div className="tv-list">
					{matches.map((match, i) => (
						<Row key={i} k={match.score !== null ? match.score.toFixed(3) : undefined}>
							<span className="tv-pattern">{match.label}</span>
							{match.serverName && <Badge>{match.serverName}</Badge>}
							{match.name && match.name !== match.label && <span className="tv-faint"> {match.name}</span>}
							{match.description && (
								<span className="tv-muted"> — {truncate(normalizeWs(match.description), 140)}</span>
							)}
						</Row>
					))}
				</div>
			)}
			{(!details || result?.isError) && <ResultText result={result} maxLines={10} />}
		</>
	);
}

export const searchBm25Renderer: ToolRenderer = { Summary, Body };
