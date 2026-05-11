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
	notifyTitleChanged?: () => Promise<void> | void;
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
