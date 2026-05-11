import type { AcpBuiltinCommandRuntime, AcpBuiltinSlashCommandResult } from "./types";

export interface ParsedSubcommand {
	verb: string;
	rest: string;
}

export type ConfigScope = "user" | "project";

export interface NamedScopeArgs {
	name?: string;
	scope: ConfigScope;
	error?: string;
}

export function commandConsumed(): AcpBuiltinSlashCommandResult {
	return { consumed: true };
}

export function usage(text: string, runtime: AcpBuiltinCommandRuntime): AcpBuiltinSlashCommandResult {
	void runtime.output(text);
	return commandConsumed();
}

export function parseSubcommand(input: string): ParsedSubcommand {
	const trimmed = input.trim();
	if (!trimmed) return { verb: "", rest: "" };
	const spaceIdx = trimmed.search(/\s/);
	if (spaceIdx === -1) return { verb: trimmed.toLowerCase(), rest: "" };
	return { verb: trimmed.slice(0, spaceIdx).toLowerCase(), rest: trimmed.slice(spaceIdx + 1).trim() };
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function parseNamedScopeArgs(rest: string, invalidScopeMessage: string): NamedScopeArgs {
	const tokens = rest.split(/\s+/).filter(Boolean);
	let name: string | undefined;
	let scope: ConfigScope = "project";
	let i = 0;
	if (tokens.length > 0 && !tokens[0]!.startsWith("-")) {
		name = tokens[0];
		i = 1;
	}
	while (i < tokens.length) {
		const token = tokens[i]!;
		if (token !== "--scope") return { scope, error: `Unknown option: ${token}` };
		const value = tokens[i + 1];
		if (!value || (value !== "project" && value !== "user")) return { scope, error: invalidScopeMessage };
		scope = value;
		i += 2;
	}
	return { name, scope };
}
