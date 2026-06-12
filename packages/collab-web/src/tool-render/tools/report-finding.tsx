/** `report_finding` — a structured code-review finding from a reviewer agent. */
import type { ReactNode } from "react";
import type { Tone } from "../parts";
import { Badge, Badges, Output, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { num, str, truncate } from "../util";

function priorityTone(priority: string): Tone | undefined {
	switch (priority) {
		case "P0":
			return "err";
		case "P1":
			return "warn";
		case "P3":
			return "accent";
		default:
			return undefined;
	}
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const priority = str(args.priority);
	const title = str(args.title);
	return (
		<>
			{priority && <Badge tone={priorityTone(priority)}>{priority}</Badge>}
			{title && <span> {truncate(title.replace(/^\[P\d\]\s*/, ""), 80)}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const priority = str(args.priority);
	const confidence = num(args.confidence);
	const filePath = str(args.file_path);
	const lineStart = num(args.line_start);
	const lineEnd = num(args.line_end);
	const body = str(args.body);
	return (
		<>
			<Badges
				items={[
					priority && <Badge tone={priorityTone(priority)}>{priority}</Badge>,
					confidence !== null && <Badge>confidence {(confidence * 100).toFixed(0)}%</Badge>,
					filePath && <PathText path={filePath} from={lineStart ?? undefined} to={lineEnd ?? undefined} />,
				]}
			/>
			{body && <Output text={body} maxLines={12} />}
			{result?.isError && <ResultText result={result} maxLines={6} />}
		</>
	);
}

export const reportFindingRenderer: ToolRenderer = { Summary, Body };
