import { bareModelId, parseOpenAIModel, semverEqual } from "@oh-my-pi/pi-catalog/identity";

/** Whether task guidance should follow Codex's GPT-5.6-specific delegation policy. */
export function usesCodexTaskPrompt(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const parsed = parseOpenAIModel(bareModelId(modelId));
	return parsed !== null && semverEqual(parsed.version, "5.6");
}
