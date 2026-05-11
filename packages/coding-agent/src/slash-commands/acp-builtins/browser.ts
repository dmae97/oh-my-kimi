import type { SettingPath, SettingValue } from "../../config/settings";
import { commandConsumed, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const browserCommand: AcpBuiltinCommandSpec = {
	name: "browser",
	description: "Toggle browser headless vs visible mode",
	inputHint: "[headless|visible]",
	handle: async (command, runtime) => {
		const arg = command.args.toLowerCase();
		const enabled = runtime.settings.get("browser.enabled" as SettingPath) as boolean;
		if (!enabled) return usage("Browser tool is disabled (enable in settings).", runtime);
		const current = runtime.settings.get("browser.headless" as SettingPath) as boolean;
		let next = current;
		if (!arg) next = !current;
		else if (["headless", "hidden"].includes(arg)) next = true;
		else if (["visible", "show", "headful"].includes(arg)) next = false;
		else return usage("Usage: /browser [headless|visible]", runtime);
		runtime.settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
		const tool = runtime.session.getToolByName("browser");
		if (tool && "restartForModeChange" in tool) {
			await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
		}
		await runtime.output(`Browser mode: ${next ? "headless" : "visible"}`);
		return commandConsumed();
	},
};
