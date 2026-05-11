import { commandConsumed, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const fastCommand: AcpBuiltinCommandSpec = {
	name: "fast",
	description: "Toggle fast mode",
	inputHint: "[on|off|status]",
	handle: async (command, runtime) => {
		const arg = command.args.toLowerCase();
		if (!arg || arg === "toggle") {
			const enabled = runtime.session.toggleFastMode();
			await runtime.output(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
			return commandConsumed();
		}
		if (arg === "on") {
			runtime.session.setFastMode(true);
			await runtime.output("Fast mode enabled.");
			return commandConsumed();
		}
		if (arg === "off") {
			runtime.session.setFastMode(false);
			await runtime.output("Fast mode disabled.");
			return commandConsumed();
		}
		if (arg === "status") {
			await runtime.output(`Fast mode is ${runtime.session.isFastModeEnabled() ? "on" : "off"}.`);
			return commandConsumed();
		}
		return usage("Usage: /fast [on|off|status]", runtime);
	},
};
