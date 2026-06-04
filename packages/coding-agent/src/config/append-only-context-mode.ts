/** Provider metadata needed to resolve append-only context mode. */
export interface AppendOnlyContextModel {
	provider: string;
	baseUrl: string;
	compat?: object;
}

function isXiaomiHost(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return host === "xiaomimimo.com" || host.endsWith(".xiaomimimo.com");
	} catch {
		return false;
	}
}

function shouldAutoEnableAppendOnlyContext(model: AppendOnlyContextModel | null | undefined): boolean {
	if (!model) return false;
	if (model.provider === "deepseek") return true;
	if (isXiaomiHost(model.baseUrl)) return true;
	return !!model.compat && "supportsStore" in model.compat && model.compat.supportsStore === true;
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
