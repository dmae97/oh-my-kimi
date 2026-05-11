import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { ACP_BUILTIN_COMMANDS } from "./acp-builtins/commands";
import type {
	AcpBuiltinCommandRuntime,
	AcpBuiltinCommandSpec,
	AcpBuiltinSlashCommandResult,
	ParsedAcpCommand,
} from "./acp-builtins/types";

export type { AcpBuiltinCommandRuntime, AcpBuiltinSlashCommandResult } from "./acp-builtins/types";

function parseAcpBuiltinSlashCommand(text: string): ParsedAcpCommand | null {
	if (!text.startsWith("/")) return null;
	const body = text.slice(1);
	if (!body) return null;
	const firstWhitespace = body.search(/\s/);
	const firstColon = body.indexOf(":");
	const firstSeparator =
		firstWhitespace === -1 ? firstColon : firstColon === -1 ? firstWhitespace : Math.min(firstWhitespace, firstColon);
	if (firstSeparator === -1) return { name: body, args: "", text };
	return { name: body.slice(0, firstSeparator), args: body.slice(firstSeparator + 1).trim(), text };
}

export const ACP_BUILTIN_SLASH_COMMANDS: AvailableCommand[] = ACP_BUILTIN_COMMANDS.map(command => ({
	name: command.name,
	description: command.description,
	input: command.inputHint ? { hint: command.inputHint } : undefined,
}));

const COMMAND_LOOKUP = new Map<string, AcpBuiltinCommandSpec>();
for (const command of ACP_BUILTIN_COMMANDS) {
	COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) COMMAND_LOOKUP.set(alias, command);
}

export async function executeAcpBuiltinSlashCommand(
	text: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parseAcpBuiltinSlashCommand(text);
	if (!parsed) return false;
	const command = COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	return await command.handle(parsed, runtime);
}
