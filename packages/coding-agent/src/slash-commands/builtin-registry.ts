import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/utils/oauth";
import { Snowflake, setProjectDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import type { SettingPath, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "../discovery/helpers.js";
import { PluginManager } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace";
import { resolveMemoryBackend } from "../memory-backend";
import type { InteractiveModeContext } from "../modes/types";
import { getChangelogPath, parseChangelog } from "../utils/changelog";
import { buildContextReportText } from "./helpers/context-report";
import { formatDuration } from "./helpers/format";
import { createMarketplaceManager } from "./helpers/marketplace-manager";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.updateEditorTopBorder();
	ctx.ui.requestRender();
}

const shutdownHandlerTui = (_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): void => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
};

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "settings",
		description: "Open settings menu",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "loop",
		description:
			"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable.",
		inlineHint: "[count|duration]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "model",
		aliases: ["models"],
		description: "Select model (opens selector UI)",
		acpDescription: "Show current model selection",
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: "Toggle fast mode (OpenAI service tier priority)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
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
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode enabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode disabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				const enabled = runtime.ctx.session.isFastModeEnabled();
				runtime.ctx.showStatus(`Fast mode is ${enabled ? "on" : "off"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "export",
		description: "Export session to HTML file",
		inlineHint: "[path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			// Match the interactive `/export` behavior: clipboard aliases are not a
			// valid export target. Without this, the literal value (`copy`,
			// `--copy`, `clipboard`) is passed to `exportToHtml` and becomes the
			// output filename.
			if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
				return usage("Use /dump to copy the session to clipboard.", runtime);
			}
			try {
				const filePath = await runtime.session.exportToHtml(arg || undefined);
				await runtime.output(`Session exported to: ${filePath}`);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		description: "Copy session transcript to clipboard",
		acpDescription: "Return full transcript as plain text",
		handle: async (_command, runtime) => {
			const text = runtime.session.formatSessionAsText();
			await runtime.output(text || "No messages to dump yet.");
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "share",
		description: "Share session as a secret GitHub gist",
		handle: async (_command, runtime) => {
			const tmpFile = path.join(os.tmpdir(), `${Snowflake.next()}.html`);
			try {
				try {
					await runtime.session.exportToHtml(tmpFile);
				} catch (err) {
					return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
				}
				const result = await $`gh gist create --public=false ${tmpFile}`.quiet().nothrow();
				if (result.exitCode !== 0) {
					return usage(
						`Failed to create gist: ${result.stderr.toString("utf-8").trim() || "unknown error"}`,
						runtime,
					);
				}
				const gistUrl = result.stdout.toString("utf-8").trim();
				const gistId = gistUrl.split("/").pop();
				if (!gistId) return usage("Failed to parse gist ID from gh output", runtime);
				await runtime.output(`Share URL: https://gistpreview.github.io/?${gistId}\nGist: ${gistUrl}`);
				return commandConsumed();
			} catch {
				return usage("GitHub CLI (gh) is required for /share. Install it from https://cli.github.com/.", runtime);
			} finally {
				await fs.rm(tmpFile, { force: true }).catch(() => {});
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "browser",
		description: "Toggle browser headless vs visible mode",
		acpInputHint: "[headless|visible]",
		subcommands: [
			{ name: "headless", description: "Switch to headless mode" },
			{ name: "visible", description: "Switch to visible mode" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = runtime.settings.get("browser.enabled" as SettingPath) as boolean;
			if (!enabled) return usage("Browser tool is disabled (enable in settings).", runtime);
			const current = runtime.settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage("Usage: /browser [headless|visible]", runtime);
			runtime.settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (err) {
					// Setting was already mutated; surface the restart failure so the
					// user knows the browser is in an inconsistent state.
					await runtime.output(
						`Browser mode set to ${next ? "headless" : "visible"}, but restart failed: ${errorMessage(err)}`,
					);
					return commandConsumed();
				}
			}
			await runtime.output(`Browser mode: ${next ? "headless" : "visible"}`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
				runtime.ctx.showWarning("Browser tool is disabled (enable in settings)");
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus("Usage: /browser [headless|visible]");
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(`Failed to restart browser: ${errorMessage(error)}`);
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(`Browser mode: ${next ? "headless" : "visible"}`);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "copy",
		description: "Copy last agent message to clipboard",
		subcommands: [
			{ name: "last", description: "Copy full last agent message" },
			{ name: "code", description: "Copy last code block" },
			{ name: "all", description: "Copy all code blocks from last message" },
			{ name: "cmd", description: "Copy last bash/python command" },
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || undefined;
			await runtime.ctx.handleCopyCommand(sub);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "todo",
		description: "View or modify the agent's todo list",
		acpDescription: "Manage todos",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "Append a task; phase fuzzy-matched or auto-created",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		description: "Session management commands",
		acpDescription: "Show session information",
		acpInputHint: "info|delete",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args || command.args === "info") {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (command.args === "delete") {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
				);
				return commandConsumed();
			}
			return usage("Usage: /session [info|delete]", runtime);
		},
		handleTui: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || "info";
			if (sub === "delete") {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			// Default: show session info
			await runtime.ctx.handleSessionCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = ["Background Jobs", `Running: ${snapshot.running.length}`];
			if (snapshot.running.length > 0) {
				lines.push("", "Running Jobs");
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", "Recent Jobs");
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		handle: async (_command, runtime) => {
			await runtime.output(await buildUsageReportText(runtime));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleUsageCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "changelog",
		description: "Show changelog entries",
		acpDescription: "Show changelog",
		acpInputHint: "[full]",
		subcommands: [{ name: "full", description: "Show complete changelog" }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const showFull = command.args.trim().toLowerCase() === "full";
			const entriesToShow = showFull ? allEntries : allEntries.slice(0, 3);
			if (entriesToShow.length === 0) {
				await runtime.output("No changelog entries found.");
				return commandConsumed();
			}
			await runtime.output(
				[...entriesToShow]
					.reverse()
					.map(entry => entry.content)
					.join("\n\n"),
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			await runtime.output(all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`).join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "context",
		description: "Show estimated context usage breakdown",
		acpDescription: "Show context usage",
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		description: "Open Extension Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		description: "Open Agent Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		description: "Create a new branch from a previous message",
		handleTui: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		description: "Create a new fork from a previous message",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		description: "Logout from OAuth provider",
		handleTui: (_command, runtime) => {
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
	{
		name: "ssh",
		description: "Manage SSH hosts (add, list, remove)",
		acpDescription: "Manage SSH connections",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add an SSH host",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		description: "Start a new session",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "drop",
		description: "Delete the current session and start a new one",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDropCommand();
		},
	},
	{
		name: "compact",
		description: "Manually compact the session context",
		acpDescription: "Compact the conversation",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const before = runtime.session.getContextUsage?.();
			const beforeTokens = before?.tokens;
			try {
				await runtime.session.compact(command.args || undefined);
			} catch (err) {
				// Compaction precondition failures (no model, already compacted, too
				// small) and provider errors propagate as plain Errors; surface them
				// via runtime.output so they don't fail the ACP prompt turn.
				return usage(`Compaction failed: ${errorMessage(err)}`, runtime);
			}
			const after = runtime.session.getContextUsage?.();
			const afterTokens = after?.tokens;
			if (beforeTokens != null && afterTokens != null) {
				const saved = beforeTokens - afterTokens;
				await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
			} else {
				await runtime.output("Compaction complete.");
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleCompactCommand(customInstructions);
		},
	},
	{
		name: "handoff",
		description: "Hand off session context to a new session",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	{
		name: "resume",
		description: "Resume a different session",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSessionSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "btw",
		description: "Ask an ephemeral side question using the current session context",
		inlineHint: "<question>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "retry",
		description: "Retry the last failed agent turn",
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus("Nothing to retry");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "background",
		aliases: ["bg"],
		description: "Detach UI and continue running in background",
		handleTui: (_command, runtime) => {
			runtime.ctx.editor.setText("");
			runtime.handleBackgroundCommand();
		},
	},
	{
		name: "debug",
		description: "Open debug tools selector",
		handleTui: (_command, runtime) => {
			runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "memory",
		description: "Inspect and operate memory maintenance",
		acpDescription: "Manage memory",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "Show current memory injection payload" },
			{ name: "clear", description: "Clear persisted memory data and artifacts" },
			{ name: "reset", description: "Alias for clear" },
			{ name: "enqueue", description: "Enqueue memory consolidation maintenance" },
			{ name: "rebuild", description: "Alias for enqueue" },
			{ name: "mm list", description: "List mental models on the active bank" },
			{ name: "mm show", description: "Show one mental model (id required)" },
			{
				name: "mm refresh",
				description: "Refresh auto-refresh models bank-wide, or one model by id",
			},
			{ name: "mm history", description: "Diff the change history of a mental model" },
			{ name: "mm seed", description: "Create any built-in mental models that are missing" },
			{ name: "mm delete", description: "Delete a mental model from the bank (id required)" },
			{ name: "mm reload", description: "Re-pull the cached <mental_models> block" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || "Memory payload is empty.");
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output("Memory cleared.");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("Memory consolidation enqueued.");
					return commandConsumed();
				}
				case "mm":
					return usage(
						"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						runtime,
					);
				default:
					return usage("Usage: /memory <view|clear|reset|enqueue|rebuild>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		description: "Rename the current session",
		inlineHint: "<title>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args) return usage("Usage: /rename <title>", runtime);
			const ok = await runtime.sessionManager.setSessionName(command.args, "user");
			if (!ok) {
				await runtime.output("Session name not changed (a user-set name takes precedence).");
				return commandConsumed();
			}
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session renamed to ${command.args}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError("Usage: /rename <title>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		description: "Move session to a different working directory",
		acpDescription: "Move the current session file",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
			if (!command.args) return usage("Usage: /move <path>", runtime);
			const resolvedPath = path.resolve(runtime.cwd, command.args);
			let isDirectory: boolean;
			try {
				isDirectory = (await fs.stat(resolvedPath)).isDirectory();
			} catch {
				return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
			}
			if (!isDirectory) return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
			try {
				await runtime.sessionManager.flush();
				await runtime.sessionManager.moveTo(resolvedPath);
			} catch (err) {
				return usage(`Move failed: ${errorMessage(err)}`, runtime);
			}
			setProjectDir(resolvedPath);
			// Reload plugin/capability caches so the next prompt sees commands and
			// capabilities scoped to the new cwd.
			await runtime.reloadPlugins();
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session moved to ${runtime.sessionManager.getCwd()}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const targetPath = command.args;
			if (!targetPath) {
				runtime.ctx.showError("Usage: /move <path>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(targetPath);
		},
	},
	{
		name: "exit",
		description: "Exit the application",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "marketplace",
		description: "Manage marketplace plugin sources and installed plugins",
		acpDescription: "Manage plugins from marketplaces",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "add", description: "Add a marketplace source", usage: "<source>" },
			{ name: "remove", description: "Remove a marketplace source", usage: "<name>" },
			{ name: "update", description: "Update marketplace catalog(s)", usage: "[name]" },
			{ name: "list", description: "List configured marketplaces" },
			{ name: "discover", description: "Browse available plugins", usage: "[marketplace]" },
			{
				name: "install",
				description: "Install a plugin (interactive browser if no args)",
				usage: "[--force] [name@marketplace]",
			},
			{ name: "uninstall", description: "Uninstall a plugin (selector if no args)", usage: "[name@marketplace]" },
			{ name: "installed", description: "List installed marketplace plugins" },
			{ name: "upgrade", description: "Upgrade outdated plugins", usage: "[name@marketplace]" },
			{ name: "help", description: "Show usage guide" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) {
				try {
					const manager = await createMarketplaceManager(runtime);
					const marketplaces = await manager.listMarketplaces();
					if (marketplaces.length === 0) {
						await runtime.output(
							"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse with /marketplace discover",
						);
					} else {
						const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
						await runtime.output(
							`Marketplaces:\n${lines.join("\n")}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands`,
						);
					}
					return commandConsumed();
				} catch (err) {
					return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
				}
			}
			if (verb === "help") {
				await runtime.output(
					[
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
					].join("\n"),
				);
				return commandConsumed();
			}
			if ((verb === "install" || verb === "uninstall") && !rest) {
				return usage(
					"Interactive plugin pickers are TUI-only. Pass an explicit name@marketplace argument.",
					runtime,
				);
			}
			try {
				const manager = await createMarketplaceManager(runtime);
				switch (verb) {
					case "add": {
						if (!rest) return usage("Usage: /marketplace add <source>", runtime);
						const entry = await manager.addMarketplace(rest);
						await runtime.output(`Added marketplace: ${entry.name}`);
						return commandConsumed();
					}
					case "remove":
					case "rm": {
						if (!rest) return usage("Usage: /marketplace remove <name>", runtime);
						await manager.removeMarketplace(rest);
						await runtime.output(`Removed marketplace: ${rest}`);
						return commandConsumed();
					}
					case "update": {
						if (rest) {
							await manager.updateMarketplace(rest);
							await runtime.output(`Updated marketplace: ${rest}`);
						} else {
							const results = await manager.updateAllMarketplaces();
							await runtime.output(`Updated ${results.length} marketplace(s)`);
						}
						return commandConsumed();
					}
					case "list": {
						const marketplaces = await manager.listMarketplaces();
						if (marketplaces.length === 0) {
							await runtime.output("No marketplaces configured.");
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							await runtime.output(`Marketplaces:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "discover": {
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
					case "install": {
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
					case "uninstall": {
						const parsed = parsePluginScopeArgs(
							rest,
							"Usage: /marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in parsed) return usage(parsed.error, runtime);
						await manager.uninstallPlugin(parsed.pluginId, parsed.scope);
						await runtime.reloadPlugins();
						await runtime.output(`Uninstalled ${parsed.pluginId}`);
						return commandConsumed();
					}
					case "installed": {
						const installed = await manager.listInstalledPlugins();
						if (installed.length === 0) {
							await runtime.output("No marketplace plugins installed");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							await runtime.output(`Installed plugins:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "upgrade": {
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
							const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
							await runtime.output(`Upgraded ${results.length} plugin(s):\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					default:
						return usage(
							`Unknown /marketplace subcommand: ${verb}. Use /marketplace help for available commands.`,
							runtime,
						);
				}
			} catch (err) {
				return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "install";
			const rest = args.slice(1).join(" ").trim();

			// /marketplace (no args) or /marketplace install (no args) → interactive browser
			if ((sub === "install" && !rest) || (!args[0] && !command.args.trim())) {
				try {
					runtime.ctx.showPluginSelector("install");
				} catch (err) {
					runtime.ctx.showStatus(`Marketplace error: ${err}`);
				}
				return;
			}

			const mgr = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
					runtime.ctx.sessionManager.getCwd(),
				),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});

			try {
				switch (sub) {
					case "add": {
						if (!rest) {
							runtime.ctx.showStatus("Usage: /marketplace add <source>");
							return;
						}
						const entry = await mgr.addMarketplace(rest);
						runtime.ctx.showStatus(`Added marketplace: ${entry.name}`);
						break;
					}
					case "remove":
					case "rm": {
						if (!rest) {
							runtime.ctx.showStatus("Usage: /marketplace remove <name>");
							return;
						}
						await mgr.removeMarketplace(rest);
						runtime.ctx.showStatus(`Removed marketplace: ${rest}`);
						break;
					}
					case "update": {
						if (rest) {
							await mgr.updateMarketplace(rest);
							runtime.ctx.showStatus(`Updated marketplace: ${rest}`);
						} else {
							const results = await mgr.updateAllMarketplaces();
							runtime.ctx.showStatus(`Updated ${results.length} marketplace(s)`);
						}
						break;
					}
					case "discover": {
						const plugins = await mgr.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await mgr.listMarketplaces();
							if (marketplaces.length === 0) {
								runtime.ctx.showStatus(
									"No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official",
								);
							} else {
								runtime.ctx.showStatus("No plugins available in configured marketplaces");
							}
						} else {
							const lines = plugins.map(
								p =>
									`  ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` - ${p.description}` : ""}`,
							);
							runtime.ctx.showStatus(`Available plugins:\n${lines.join("\n")}`);
						}
						break;
					}
					case "install": {
						// Parse: /marketplace install [--force] [--scope user|project] name@marketplace
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const atIdx = parsed.installSpec.lastIndexOf("@");
						const name = parsed.installSpec.slice(0, atIdx);
						const marketplace = parsed.installSpec.slice(atIdx + 1);
						await mgr.installPlugin(name, marketplace, { force: parsed.force, scope: parsed.scope });
						runtime.ctx.showStatus(`Installed ${name} from ${marketplace}`);
						break;
					}
					case "uninstall": {
						if (!rest) {
							// No args → open interactive uninstall selector
							runtime.ctx.showPluginSelector("uninstall");
							return;
						}
						const uninstArgs = parsePluginScopeArgs(
							rest,
							"Usage: /marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in uninstArgs) {
							runtime.ctx.showStatus(uninstArgs.error);
							return;
						}
						await mgr.uninstallPlugin(uninstArgs.pluginId, uninstArgs.scope);
						runtime.ctx.showStatus(`Uninstalled ${uninstArgs.pluginId}`);
						break;
					}
					case "installed": {
						const installed = await mgr.listInstalledPlugins();
						if (installed.length === 0) {
							runtime.ctx.showStatus("No marketplace plugins installed");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							runtime.ctx.showStatus(`Installed plugins:\n${lines.join("\n")}`);
						}
						break;
					}
					case "upgrade": {
						if (rest) {
							const upArgs = parsePluginScopeArgs(
								rest,
								"Usage: /marketplace upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in upArgs) {
								runtime.ctx.showStatus(upArgs.error);
								return;
							}
							const result = await mgr.upgradePlugin(upArgs.pluginId, upArgs.scope);
							runtime.ctx.showStatus(`Upgraded ${upArgs.pluginId} to ${result.version}`);
						} else {
							const results = await mgr.upgradeAllPlugins();
							if (results.length === 0) {
								runtime.ctx.showStatus("All marketplace plugins are up to date");
							} else {
								const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
								runtime.ctx.showStatus(`Upgraded ${results.length} plugin(s):\n${lines.join("\n")}`);
							}
						}
						break;
					}
					case "help": {
						runtime.ctx.showStatus(
							[
								"Marketplace commands:",
								"  /marketplace                              Browse and install plugins",
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
								"  /marketplace                               (opens interactive browser)",
							].join("\n"),
						);
						break;
					}
					default: {
						const marketplaces = await mgr.listMarketplaces();
						if (marketplaces.length === 0) {
							runtime.ctx.showStatus(
								"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse plugins with /marketplace or /marketplace discover",
							);
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							runtime.ctx.showStatus(
								`Marketplaces:\n${lines.join("\n")}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands`,
							);
						}
						break;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				runtime.ctx.showStatus(`Marketplace error: ${msg}`);
			}
		},
	},
	{
		name: "plugins",
		description: "View and manage installed plugins",
		acpDescription: "Manage plugins",
		acpInputHint: "[list|enable|disable]",
		subcommands: [
			{ name: "list", description: "List all installed plugins (npm + marketplace)" },
			{ name: "enable", description: "Enable a marketplace plugin", usage: "<name@marketplace>" },
			{ name: "disable", description: "Disable a marketplace plugin", usage: "<name@marketplace>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			try {
				if (verb === "enable" || verb === "disable") {
					const parsed = parsePluginScopeArgs(
						rest,
						`Usage: /plugins ${verb} [--scope user|project] <name@marketplace>`,
					);
					if ("error" in parsed) return usage(parsed.error, runtime);
					const manager = await createMarketplaceManager(runtime);
					const isEnable = verb === "enable";
					await manager.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
					await runtime.reloadPlugins();
					await runtime.output(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
					return commandConsumed();
				}
				// Default: list
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
			} catch (err) {
				return usage(`Plugin error: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "list";
			const rest = args.slice(1).join(" ").trim();

			try {
				const mgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
						runtime.ctx.sessionManager.getCwd(),
					),
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: clearPluginRootsAndCaches,
				});

				switch (sub) {
					case "enable":
					case "disable": {
						const parsed = parsePluginScopeArgs(
							rest ?? "",
							`Usage: /plugins ${sub} [--scope user|project] <name@marketplace>`,
						);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const isEnable = sub === "enable";
						await mgr.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
						runtime.ctx.showStatus(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
						break;
					}
					default: {
						const lines: string[] = [];

						const npm = new PluginManager();
						const npmPlugins = await npm.list();
						if (npmPlugins.length > 0) {
							lines.push("npm plugins:");
							for (const p of npmPlugins) {
								const status = p.enabled === false ? " (disabled)" : "";
								lines.push(`  ${p.name}@${p.version}${status}`);
							}
						}

						const mktPlugins = await mgr.listInstalledPlugins();
						if (mktPlugins.length > 0) {
							if (lines.length > 0) lines.push("");
							lines.push("marketplace plugins:");
							for (const p of mktPlugins) {
								const entry = p.entries[0];
								const status = entry?.enabled === false ? " (disabled)" : "";
								const shadowed = p.shadowedBy ? " [shadowed]" : "";
								lines.push(`  ${p.id} v${entry?.version ?? "?"}${status} [${p.scope}]${shadowed}`);
							}
						}

						if (lines.length === 0) {
							runtime.ctx.showStatus("No plugins installed");
						} else {
							runtime.ctx.showStatus(lines.join("\n"));
						}
						break;
					}
				}
			} catch (err) {
				runtime.ctx.showStatus(`Plugin error: ${err}`);
			}
		},
	},
	{
		name: "reload-plugins",
		description: "Reload all plugins (skills, commands, hooks, tools, agents, MCP)",
		acpDescription: "Reload all plugins",
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output("Plugins reloaded.");
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			// Invalidate registry fs caches and the plugin roots cache so
			// listClaudePluginRoots re-reads from disk on next access.
			const projectPath = await resolveActiveProjectRegistryPath(runtime.ctx.sessionManager.getCwd());
			clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
			await runtime.ctx.refreshSlashCommandState();
			runtime.ctx.showStatus("Plugins reloaded.");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "force",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "quit",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
	}),
);

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: async () => {
				const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
				clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
				await ctx.refreshSlashCommandState();
			},
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
