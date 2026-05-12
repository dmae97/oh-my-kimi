import { commandConsumed, errorMessage, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const modelCommand: AcpBuiltinCommandSpec = {
	name: "model",
	description: "Show current model selection",
	aliases: ["models"],
	handle: async (command, runtime) => {
		if (command.args) {
			const modelId = command.args.trim();
			const availableModels = runtime.session.getAvailableModels?.() ?? [];
			const match = availableModels.find(
				model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
			);
			if (!match) {
				return usage(
					`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
					runtime,
				);
			}
			try {
				await runtime.session.setModel(match);
				await runtime.output(`Model set to ${match.provider}/${match.id}.`);
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
			}
		}

		const model = runtime.session.model;
		await runtime.output(model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.");
		return commandConsumed();
	},
};
