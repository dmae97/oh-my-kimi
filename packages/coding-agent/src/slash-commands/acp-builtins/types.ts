import type { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";

export interface ParsedAcpCommand {
	name: string;
	args: string;
	text: string;
}

export interface AcpBuiltinCommandRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	cwd: string;
	output: (text: string) => Promise<void> | void;
	refreshCommands: () => Promise<void> | void;
	/**
	 * Reload plugin state (caches, slash command registry, project registries)
	 * and emit a fresh `available_commands_update`. Called by `/reload-plugins`,
	 * `/move`, and `/marketplace`/`/plugins` mutations so the session and the
	 * ACP client see a consistent view after plugin or project-scope changes.
	 */
	reloadPlugins: () => Promise<void>;
	notifyTitleChanged?: () => Promise<void> | void;
	notifyConfigChanged?: () => Promise<void> | void;
}

export type AcpBuiltinSlashCommandResult = false | { consumed: true } | { prompt: string };

export interface AcpBuiltinCommandSpec {
	name: string;
	description: string;
	inputHint?: string;
	aliases?: string[];
	handle: (
		command: ParsedAcpCommand,
		runtime: AcpBuiltinCommandRuntime,
	) => Promise<AcpBuiltinSlashCommandResult> | AcpBuiltinSlashCommandResult;
}
