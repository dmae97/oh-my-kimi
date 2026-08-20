import { resolvePromptPreset } from "../../prompt-preset.ts";
import type { ExtensionAPI } from "../types.ts";

export default function promptPreset(omk: ExtensionAPI): void {
	omk.on("before_agent_start", (_event, ctx) => {
		const model = ctx.model;
		const preset = resolvePromptPreset(model ? `${model.provider}/${model.id}` : undefined);
		if (!preset) return undefined;
		return {
			systemPrompt: `${_event.systemPrompt}\n\n<model_preset id="${preset.id}">\n${preset.guidelines.map((line) => `- ${line}`).join("\n")}\n</model_preset>`,
		};
	});
}
