import type { MarketplaceManager } from "../../extensibility/plugins/marketplace";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "../marketplace-install-parser";
import { createMarketplaceManager } from "./marketplace-manager";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./shared";
import type { AcpBuiltinCommandRuntime, AcpBuiltinCommandSpec, AcpBuiltinSlashCommandResult } from "./types";

function marketplaceHelpText(): string {
	return [
		"Marketplace commands:",
		"  /marketplace                              List configured marketplaces",
		"  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)",
		"  /marketplace remove <name>                 Remove a marketplace",
		"  /marketplace update [name]                 Re-fetch catalog(s)",
		"  /marketplace list                          List configured marketplaces",
		"  /marketplace discover [marketplace]        Browse available plugins",
		"  /marketplace install <name@marketplace>    Install a plugin",
		"  /marketplace uninstall <name@marketplace>  Uninstall a plugin",
		"  /marketplace installed                     List installed plugins",
		"  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)",
		"",
		"Quick start:",
		"  /marketplace add anthropics/claude-plugins-official",
	].join("\n");
}

async function handleSummaryCommand(runtime: AcpBuiltinCommandRuntime): Promise<AcpBuiltinSlashCommandResult> {
	try {
		const manager = await createMarketplaceManager(runtime);
		const marketplaces = await manager.listMarketplaces();
		if (marketplaces.length === 0) {
			await runtime.output(
				"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse with /marketplace discover",
			);
		} else {
			const lines = marketplaces.map(marketplace => `  ${marketplace.name}  ${marketplace.sourceUri}`);
			await runtime.output(
				`Marketplaces:\n${lines.join("\n")}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands`,
			);
		}
		return commandConsumed();
	} catch (err) {
		return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
	}
}

async function handleDiscoverCommand(
	manager: MarketplaceManager,
	rest: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const plugins = await manager.listAvailablePlugins(rest || undefined);
	if (plugins.length === 0) {
		const marketplaces = await manager.listMarketplaces();
		await runtime.output(
			marketplaces.length === 0
				? "No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official"
				: "No plugins available in configured marketplaces",
		);
		return commandConsumed();
	}

	const lines = ["Available plugins:"];
	for (const plugin of plugins) {
		lines.push(`  - ${plugin.name}${plugin.version ? `@${plugin.version}` : ""}`);
		if (plugin.description) lines.push(`      ${plugin.description}`);
	}
	await runtime.output(lines.join("\n"));
	return commandConsumed();
}

async function handleInstallCommand(
	manager: MarketplaceManager,
	rest: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parseMarketplaceInstallArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const atIndex = parsed.installSpec.lastIndexOf("@");
	const pluginName = parsed.installSpec.slice(0, atIndex);
	const marketplace = parsed.installSpec.slice(atIndex + 1);
	await manager.installPlugin(pluginName, marketplace, { force: parsed.force, scope: parsed.scope });
	await runtime.reloadPlugins();
	await runtime.output(`Installed ${pluginName} from ${marketplace}`);
	return commandConsumed();
}

async function handleUninstallCommand(
	manager: MarketplaceManager,
	rest: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parsePluginScopeArgs(rest, "Usage: /marketplace uninstall [--scope user|project] <name@marketplace>");
	if ("error" in parsed) return usage(parsed.error, runtime);
	await manager.uninstallPlugin(parsed.pluginId, parsed.scope);
	await runtime.reloadPlugins();
	await runtime.output(`Uninstalled ${parsed.pluginId}`);
	return commandConsumed();
}

async function handleInstalledCommand(
	manager: MarketplaceManager,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const installed = await manager.listInstalledPlugins();
	if (installed.length === 0) {
		await runtime.output("No marketplace plugins installed");
	} else {
		const lines = installed.map(
			plugin =>
				`  ${plugin.id} [${plugin.scope}]${plugin.shadowedBy ? " [shadowed]" : ""} (${plugin.entries.length} entry)`,
		);
		await runtime.output(`Installed plugins:\n${lines.join("\n")}`);
	}
	return commandConsumed();
}

async function handleUpgradeCommand(
	manager: MarketplaceManager,
	rest: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	if (rest) {
		const parsed = parsePluginScopeArgs(
			rest,
			"Usage: /marketplace upgrade [--scope user|project] <name@marketplace>",
		);
		if ("error" in parsed) return usage(parsed.error, runtime);
		const result = await manager.upgradePlugin(parsed.pluginId, parsed.scope);
		await runtime.reloadPlugins();
		await runtime.output(`Upgraded ${parsed.pluginId} to ${result.version}`);
		return commandConsumed();
	}

	const results = await manager.upgradeAllPlugins();
	if (results.length === 0) {
		await runtime.output("All marketplace plugins are up to date");
	} else {
		await runtime.reloadPlugins();
		const lines = results.map(result => `  ${result.pluginId}: ${result.from} -> ${result.to}`);
		await runtime.output(`Upgraded ${results.length} plugin(s):\n${lines.join("\n")}`);
	}
	return commandConsumed();
}

type MarketplaceHandler = (
	manager: MarketplaceManager,
	rest: string,
	runtime: AcpBuiltinCommandRuntime,
) => Promise<AcpBuiltinSlashCommandResult>;

async function handleAddCommand(
	manager: MarketplaceManager,
	rest: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	if (!rest) return usage("Usage: /marketplace add <source>", runtime);
	const entry = await manager.addMarketplace(rest);
	await runtime.output(`Added marketplace: ${entry.name}`);
	return commandConsumed();
}

async function handleRemoveCommand(
	manager: MarketplaceManager,
	rest: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	if (!rest) return usage("Usage: /marketplace remove <name>", runtime);
	await manager.removeMarketplace(rest);
	await runtime.output(`Removed marketplace: ${rest}`);
	return commandConsumed();
}

async function handleUpdateCommand(
	manager: MarketplaceManager,
	rest: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	if (rest) {
		await manager.updateMarketplace(rest);
		await runtime.output(`Updated marketplace: ${rest}`);
		return commandConsumed();
	}
	const results = await manager.updateAllMarketplaces();
	await runtime.output(`Updated ${results.length} marketplace(s)`);
	return commandConsumed();
}

async function handleListCommand(
	manager: MarketplaceManager,
	_rest: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const marketplaces = await manager.listMarketplaces();
	if (marketplaces.length === 0) {
		await runtime.output("No marketplaces configured.");
	} else {
		const lines = marketplaces.map(marketplace => `  ${marketplace.name}  ${marketplace.sourceUri}`);
		await runtime.output(`Marketplaces:\n${lines.join("\n")}`);
	}
	return commandConsumed();
}

const MARKETPLACE_HANDLERS = new Map<string, MarketplaceHandler>([
	["add", handleAddCommand],
	["remove", handleRemoveCommand],
	["rm", handleRemoveCommand],
	["update", handleUpdateCommand],
	["list", handleListCommand],
	["discover", handleDiscoverCommand],
	["install", handleInstallCommand],
	["uninstall", handleUninstallCommand],
	["installed", (manager, _rest, runtime) => handleInstalledCommand(manager, runtime)],
	["upgrade", handleUpgradeCommand],
]);

export const marketplaceCommand: AcpBuiltinCommandSpec = {
	name: "marketplace",
	description: "Manage plugins from marketplaces",
	inputHint: "<subcommand>",
	handle: async (command, runtime) => {
		const { verb, rest } = parseSubcommand(command.args);
		if (!verb) return await handleSummaryCommand(runtime);
		if (verb === "help") {
			await runtime.output(marketplaceHelpText());
			return commandConsumed();
		}
		if ((verb === "install" || verb === "uninstall") && !rest) {
			return usage("Interactive plugin pickers are TUI-only. Pass an explicit name@marketplace argument.", runtime);
		}
		const handler = MARKETPLACE_HANDLERS.get(verb);
		if (!handler)
			return usage(
				`Unknown /marketplace subcommand: ${verb}. Use /marketplace help for available commands.`,
				runtime,
			);
		try {
			const manager = await createMarketplaceManager(runtime);
			return await handler(manager, rest, runtime);
		} catch (err) {
			return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
		}
	},
};
