import { commandConsumed } from "./shared";
import type { AcpBuiltinCommandRuntime, AcpBuiltinCommandSpec } from "./types";

function getToolsList(runtime: AcpBuiltinCommandRuntime): string {
	const active = runtime.session.getActiveToolNames();
	const all = runtime.session.getAllToolNames();
	if (all.length === 0) return "No tools are available.";
	return all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`).join("\n");
}

export const toolsCommand: AcpBuiltinCommandSpec = {
	name: "tools",
	description: "Show available tools",
	handle: async (_command, runtime) => {
		await runtime.output(getToolsList(runtime));
		return commandConsumed();
	},
};
