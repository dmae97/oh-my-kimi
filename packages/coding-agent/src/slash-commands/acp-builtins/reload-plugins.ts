import { commandConsumed } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const reloadPluginsCommand: AcpBuiltinCommandSpec = {
	name: "reload-plugins",
	description: "Reload all plugins",
	handle: async (_command, runtime) => {
		await runtime.reloadPlugins();
		await runtime.output("Plugins reloaded.");
		return commandConsumed();
	},
};
