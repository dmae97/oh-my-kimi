/** `render_mermaid` — render a Mermaid diagram source to an image/ASCII output. */
import type { ReactNode } from "react";
import { CodeBlock, InvalidArg, ResultImages, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { normalizeWs, str, truncate } from "../util";

function firstNonEmptyLine(source: string): string {
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const source = str(args.code) ?? str(args.source) ?? str(args.mermaid);
	if (source === null) return <InvalidArg what="mermaid source" />;
	return <span>{truncate(normalizeWs(firstNonEmptyLine(source)))}</span>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const source = str(args.code) ?? str(args.source) ?? str(args.mermaid);
	return (
		<>
			{source !== null && <CodeBlock code={source} />}
			<ResultImages result={result} />
			<ResultText result={result} maxLines={6} />
		</>
	);
}

export const renderMermaidRenderer: ToolRenderer = { Summary, Body };
