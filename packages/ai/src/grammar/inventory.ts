import { preferredToolSyntax } from "@oh-my-pi/pi-catalog/identity";
import { jsonSchemaToTypeScript, toolWireSchema } from "../utils/schema";
import { renderToolExamples } from "./examples";
import type { InbandTool } from "./types";

/**
 * Human-readable per-tool inventory: each tool renders as a `# Tool: <name>`
 * section with its description, a simplified TypeScript-style parameter
 * signature (derived from the wire JSON Schema), and examples in the model's
 * native tool-call syntax. Shared by the verbose system-prompt inventory and
 * `/dump` so both render the catalog the same way.
 *
 * `model` is a model id; the native example syntax is resolved from it
 * (`preferredToolSyntax`, which falls back to XML for empty/unknown ids).
 */
export function renderToolInventory(tools: readonly InbandTool[], model: string): string {
	if (tools.length === 0) return "";
	const syntax = preferredToolSyntax(model);
	return tools
		.map(tool => {
			const params = jsonSchemaToTypeScript(toolWireSchema(tool));
			const examples = renderToolExamples(tool, syntax);
			const parts = [`# Tool: ${tool.name}`, tool.description ?? "", "", `Parameters: ${params}`];
			if (examples) parts.push("", examples);
			return parts.join("\n");
		})
		.join("\n\n");
}
