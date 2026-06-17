import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { jsonSchemaToTypeScript, toolWireSchema } from "../utils/schema";
import { renderToolExamples } from "./examples";
import type { InbandTool } from "./types";

/**
 * Human-readable per-tool inventory: each tool renders as a `# Tool: <name>`
 * section with its description, a simplified TypeScript-style parameter
 * signature (derived from the wire JSON Schema), and examples in the model's
 * native dialect. Shared by the verbose system-prompt inventory and
 * `/dump` so both render the catalog the same way.
 *
 * `model` is a model id; the native example dialect is resolved from it
 * (`preferredDialect`, which falls back to XML for empty/unknown ids).
 */
export function renderToolInventory(tools: readonly InbandTool[], model: string): string {
	if (tools.length === 0) return "";
	const dialect = preferredDialect(model);
	return tools
		.map(tool => {
			const params = jsonSchemaToTypeScript(toolWireSchema(tool));
			const examples = renderToolExamples(tool, dialect);
			const description = demoteDescriptionHeaders(tool.description ?? "");
			const parts = [`# Tool: ${tool.name}`, description, "", `Parameters: ${params}`];
			if (examples) parts.push("", examples);
			return parts.join("\n");
		})
		.join("\n\n");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}#{1,6}( |\t|$)/;
const TOP_LEVEL = /^ {0,3}#( |\t|$)/;

/**
 * Each description is rendered under a `# Tool: <name>` heading. When the
 * description carries its own top-level (`# `) markdown headers they sit at the
 * same level as that wrapper, so the section structure flattens and the
 * description's headers read like sibling tools. Demote every ATX header in the
 * description by one level so the whole block nests under `# Tool: <name>`.
 *
 * Only triggered when a level-1 header is actually present — descriptions that
 * already start at `##` are left untouched. Headers inside fenced code blocks
 * are never rewritten.
 */
function demoteDescriptionHeaders(description: string): string {
	const lines = description.split("\n");

	let fence: string | undefined;
	let collides = false;
	for (const line of lines) {
		const marker = FENCE.exec(line)?.[1][0];
		if (marker) {
			fence = fence === undefined ? marker : fence === marker ? undefined : fence;
		} else if (fence === undefined && TOP_LEVEL.test(line)) {
			collides = true;
			break;
		}
	}
	if (!collides) return description;

	fence = undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const marker = FENCE.exec(line)?.[1][0];
		if (marker) {
			fence = fence === undefined ? marker : fence === marker ? undefined : fence;
		} else if (fence === undefined && ATX.test(line)) {
			lines[i] = line.replace(/^( {0,3})#/, "$1##");
		}
	}
	return lines.join("\n");
}
