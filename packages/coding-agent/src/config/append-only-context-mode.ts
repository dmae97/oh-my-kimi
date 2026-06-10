import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";

/** Provider metadata needed to resolve append-only context mode. */
export interface AppendOnlyContextModel {
	provider: string;
	baseUrl: string;
	/** Verbatim sparse compat config (explicit user intent), never the resolved record. */
	compatConfig?: object;
}

function shouldAutoEnableAppendOnlyContext(model: AppendOnlyContextModel | null | undefined): boolean {
	if (!model) return false;
	if (model.provider === "deepseek") return true;
	if (hostMatchesUrl(model.baseUrl, "xiaomi")) return true;
	return !!model.compatConfig && "supportsStore" in model.compatConfig && model.compatConfig.supportsStore === true;
}

/** Resolves whether append-only context should be active for a model and setting. */
export function shouldEnableAppendOnlyContext(
	setting: "auto" | "on" | "off" | undefined,
	model: AppendOnlyContextModel | null | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default:
			return shouldAutoEnableAppendOnlyContext(model);
	}
}
