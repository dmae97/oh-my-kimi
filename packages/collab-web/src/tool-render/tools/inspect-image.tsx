/** `inspect_image` — ask a vision model a question about an image file or URL. */
import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, PathText, ResultImages, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, normalizeWs, shortenPath, str, truncate } from "../util";

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const rec = detailsRecord(result);
	const target = str(args.path) ?? str(args.url) ?? (rec ? str(rec.imagePath) : null);
	if (target === null) return <InvalidArg what="image path" />;
	return <span>{truncate(shortenPath(target))}</span>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const rec = detailsRecord(result);
	const model = rec ? str(rec.model) : null;
	const mimeType = rec ? str(rec.mimeType) : null;
	const target = str(args.path) ?? str(args.url) ?? (rec ? str(rec.imagePath) : null);
	const question = str(args.question)?.trim() ?? "";
	return (
		<>
			{target !== null ? <PathText path={target} /> : <InvalidArg what="image path" />}
			{question && <Row k="question">{truncate(normalizeWs(question), 200)}</Row>}
			<Badges items={[model && <Badge tone="accent">{model}</Badge>, mimeType && <Badge>{mimeType}</Badge>]} />
			<ResultImages result={result} />
			<ResultText result={result} maxLines={8} />
		</>
	);
}

export const inspectImageRenderer: ToolRenderer = { Summary, Body };
