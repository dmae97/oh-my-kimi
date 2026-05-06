import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type MermaidAsciiRenderOptions, prompt, renderMermaidAscii } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import renderMermaidDescription from "../prompts/tools/render-mermaid.md" with { type: "text" };
import type { ToolSession } from "./index";

const renderMermaidSchema = Type.Object({
	mermaid: Type.String({ description: "mermaid source", examples: ["graph TD; A-->B"] }),
	config: Type.Optional(
		Type.Object({
			useAscii: Type.Optional(Type.Boolean()),
			paddingX: Type.Optional(Type.Number()),
			paddingY: Type.Optional(Type.Number()),
			boxBorderPadding: Type.Optional(Type.Number()),
		}),
	),
});

type RenderMermaidParams = Static<typeof renderMermaidSchema>;

function sanitizeRenderConfig(config: MermaidAsciiRenderOptions | undefined): MermaidAsciiRenderOptions | undefined {
	if (!config) return undefined;
	return {
		useAscii: config.useAscii,
		boxBorderPadding:
			config.boxBorderPadding === undefined ? undefined : Math.max(0, Math.floor(config.boxBorderPadding)),
		paddingX: config.paddingX === undefined ? undefined : Math.max(0, Math.floor(config.paddingX)),
		paddingY: config.paddingY === undefined ? undefined : Math.max(0, Math.floor(config.paddingY)),
	};
}
export interface RenderMermaidToolDetails {
	artifactId?: string;
}

export class RenderMermaidTool implements AgentTool<typeof renderMermaidSchema, RenderMermaidToolDetails> {
	readonly name = "render_mermaid";
	readonly label = "RenderMermaid";
	readonly summary = "Render a Mermaid diagram to an image";
	readonly description: string;
	readonly parameters = renderMermaidSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(renderMermaidDescription);
	}

	async execute(
		_toolCallId: string,
		params: RenderMermaidParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RenderMermaidToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RenderMermaidToolDetails>> {
		const ascii = renderMermaidAscii(params.mermaid, sanitizeRenderConfig(params.config));
		const { path: artifactPath, id: artifactId } =
			(await this.session.allocateOutputArtifact?.("render_mermaid")) ?? {};
		if (artifactPath) {
			await Bun.write(artifactPath, ascii);
		}

		const artifactLine = artifactId ? `\n\nSaved artifact: artifact://${artifactId}` : "";
		return {
			content: [{ type: "text", text: `${ascii}${artifactLine}` }],
			details: { artifactId },
		};
	}
}
