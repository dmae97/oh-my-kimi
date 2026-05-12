import { PluginManager } from "../../extensibility/plugins";
import { parsePluginScopeArgs } from "../marketplace-install-parser";
import { createMarketplaceManager } from "./marketplace-manager";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./shared";
import type { AcpBuiltinCommandRuntime, AcpBuiltinCommandSpec, AcpBuiltinSlashCommandResult } from "./types";

async function handleEnableDisableCommand(
	sub: "enable" | "disable",
	rest: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parsePluginScopeArgs(rest, `Usage: /plugins ${sub} [--scope user|project] <name@marketplace>`);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const manager = await createMarketplaceManager(runtime);
	const isEnable = sub === "enable";
	await manager.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
	await runtime.reloadPlugins();
	await runtime.output(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
	return commandConsumed();
}

async function handleListCommand(runtime: AcpBuiltinCommandRuntime): Promise<AcpBuiltinSlashCommandResult> {
	const lines: string[] = [];
	const npmManager = new PluginManager();
	const npmPlugins = await npmManager.list();
	if (npmPlugins.length > 0) {
		lines.push("npm plugins:");
		for (const plugin of npmPlugins) {
			const status = plugin.enabled === false ? " (disabled)" : "";
			lines.push(`  ${plugin.name}@${plugin.version}${status}`);
		}
	}

	const marketplaceManager = await createMarketplaceManager(runtime);
	const marketplacePlugins = await marketplaceManager.listInstalledPlugins();
	if (marketplacePlugins.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("marketplace plugins:");
		for (const plugin of marketplacePlugins) {
			const entry = plugin.entries[0];
			const status = entry?.enabled === false ? " (disabled)" : "";
			const shadowed = plugin.shadowedBy ? " [shadowed]" : "";
			lines.push(`  ${plugin.id} v${entry?.version ?? "?"}${status} [${plugin.scope}]${shadowed}`);
		}
	}

	await runtime.output(lines.length === 0 ? "No plugins installed" : lines.join("\n"));
	return commandConsumed();
}

export const pluginsCommand: AcpBuiltinCommandSpec = {
	name: "plugins",
	description: "Manage plugins",
	inputHint: "[list|enable|disable]",
	handle: async (command, runtime) => {
		const { verb, rest } = parseSubcommand(command.args);
		try {
			if (verb === "enable" || verb === "disable") return await handleEnableDisableCommand(verb, rest, runtime);
			return await handleListCommand(runtime);
		} catch (err) {
			return usage(`Plugin error: ${errorMessage(err)}`, runtime);
		}
	},
};
