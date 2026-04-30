import type { Settings } from "../config/settings";

export function isBackgroundJobSupportEnabled(settings: Pick<Settings, "get">): boolean {
	return settings.get("async.enabled") || settings.get("bash.autoBackground.enabled");
}
