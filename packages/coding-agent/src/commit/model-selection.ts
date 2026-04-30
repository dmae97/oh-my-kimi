import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { MODEL_ROLE_IDS } from "../config/model-registry";
import {
	type ModelLookupRegistry,
	parseModelPattern,
	resolveModelRoleValue,
	resolveRoleSelection,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import MODEL_PRIO from "../priority.json" with { type: "json" };

export interface ResolvedCommitModel {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
}

type CommitModelRegistry = ModelLookupRegistry & {
	getApiKey: (model: Model<Api>) => Promise<string | undefined>;
};

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: CommitModelRegistry,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	const resolved = override
		? resolveModelRoleValue(override, available, { settings, matchPreferences, modelRegistry })
		: resolveRoleSelection(["commit", "smol", ...MODEL_ROLE_IDS], settings, available, modelRegistry);
	const model = resolved?.model;
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return { model, apiKey, thinkingLevel: resolved?.thinkingLevel };
}

export async function resolveSmolModel(
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	fallbackModel: Model<Api>,
	fallbackApiKey: string,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const resolvedSmol = resolveRoleSelection(["smol"], settings, available, modelRegistry);
	if (resolvedSmol?.model) {
		const apiKey = await modelRegistry.getApiKey(resolvedSmol.model);
		if (apiKey) return { model: resolvedSmol.model, apiKey, thinkingLevel: resolvedSmol.thinkingLevel };
	}

	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	for (const pattern of MODEL_PRIO.smol) {
		const candidate = parseModelPattern(pattern, available, matchPreferences, { modelRegistry }).model;
		if (!candidate) continue;
		const apiKey = await modelRegistry.getApiKey(candidate);
		if (apiKey) return { model: candidate, apiKey };
	}

	return { model: fallbackModel, apiKey: fallbackApiKey };
}
