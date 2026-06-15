import * as os from "node:os";
import * as path from "node:path";
import { normalizeProfileName } from "@oh-my-pi/pi-utils/dirs";

export type ProfileAliasShell = "bash" | "zsh" | "fish" | "powershell" | "pwsh";

function quoteForShell(pathValue: string): string {
	return `'${pathValue.replace(/'/g, `'"'"'`)}'`;
}

function quoteForPowerShell(pathValue: string): string {
	return `'${pathValue.replace(/'/g, `''`)}'`;
}

export interface ProfileAliasCommand {
	display: string;
	posix: string;
	fish: string;
	powerShell: string;
}

const DEFAULT_ALIAS_COMMAND: ProfileAliasCommand = {
	display: "omp",
	posix: "omp",
	fish: "omp",
	powerShell: "omp",
};

export interface ProfileAliasInstallOptions {
	profile: string;
	aliasName: string;
	shellPath?: string;
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	readFile?: (filePath: string) => Promise<string>;
	command?: ProfileAliasCommand;
	writeFile?: (filePath: string, content: string) => Promise<void>;
}

export interface ProfileAliasInstallResult {
	shell: ProfileAliasShell;
	configPath: string;
	aliasName: string;
	profile: string;
	command: string;
	reloadedWith: string;
}

const ALIAS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const POSIX_RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"case",
	"coproc",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"time",
	"until",
	"while",
]);
const FISH_RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"and",
	"begin",
	"break",
	"builtin",
	"case",
	"command",
	"continue",
	"else",
	"end",
	"exec",
	"for",
	"function",
	"if",
	"not",
	"or",
	"return",
	"switch",
	"while",
]);
const POWERSHELL_RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"begin",
	"break",
	"catch",
	"class",
	"continue",
	"data",
	"do",
	"dynamicparam",
	"else",
	"elseif",
	"end",
	"enum",
	"exit",
	"filter",
	"finally",
	"for",
	"foreach",
	"from",
	"function",
	"if",
	"in",
	"param",
	"process",
	"return",
	"switch",
	"throw",
	"trap",
	"try",
	"until",
	"using",
	"var",
	"while",
	"workflow",
]);

// Keep local: importing the pi-utils root here would eagerly load env before
// cli.ts has applied --profile, regressing profile-specific .env loading.
function isEnoentError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function getReservedAliasNames(shell: ProfileAliasShell): ReadonlySet<string> {
	switch (shell) {
		case "bash":
		case "zsh":
			return POSIX_RESERVED_ALIAS_NAMES;
		case "fish":
			return FISH_RESERVED_ALIAS_NAMES;
		case "powershell":
		case "pwsh":
			return POWERSHELL_RESERVED_ALIAS_NAMES;
	}
}

function validateAliasName(aliasName: string, shell: ProfileAliasShell): string {
	const normalized = aliasName.trim();
	if (!ALIAS_NAME_RE.test(normalized)) {
		throw new Error(`Invalid alias "${aliasName}". Alias names must match ${ALIAS_NAME_RE.source}.`);
	}
	if (normalized.toLowerCase() === "omp") {
		throw new Error('Invalid alias "omp". Refusing to shadow the base omp command.');
	}
	if (getReservedAliasNames(shell).has(normalized.toLowerCase())) {
		throw new Error(`Invalid alias "${aliasName}". Refusing to create a ${shell} reserved word.`);
	}
	return normalized;
}

// On Windows the launching shell is rarely exported through $SHELL, so when it
// is missing we infer the PowerShell edition from the inherited environment.
// PowerShell 7 (pwsh) always seeds PSModulePath with separator-delimited
// ".../PowerShell/..." module directories (plus the Windows PowerShell ones for
// back-compat), whereas Windows PowerShell 5.1 only ever lists
// ".../WindowsPowerShell/...". The separator anchors keep "WindowsPowerShell"
// from matching. POWERSHELL_DISTRIBUTION_CHANNEL is set only by some pwsh
// distributions, so it stays a secondary hint rather than the primary signal.
function detectWindowsPowerShell(env: NodeJS.ProcessEnv): ProfileAliasShell {
	const modulePath = env.PSModulePath ?? env.PSMODULEPATH ?? env.psmodulepath ?? "";
	if (/[\\/]PowerShell[\\/]/i.test(modulePath)) return "pwsh";
	if (env.POWERSHELL_DISTRIBUTION_CHANNEL) return "pwsh";
	return "powershell";
}

function normalizeShellName(
	shellPath: string | undefined,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): ProfileAliasShell {
	const shell = path
		.basename(shellPath ?? "")
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (shell === "zsh") return "zsh";
	if (shell === "bash") return "bash";
	if (shell === "fish") return "fish";
	if (shell === "pwsh") return "pwsh";
	if (shell === "powershell") return "powershell";
	if (platform === "win32") return detectWindowsPowerShell(env);
	throw new Error(`Unsupported shell${shell ? ` "${shell}"` : ""}. Supported shells: bash, zsh, fish, PowerShell.`);
}

export function resolveProfileAliasCommandFromProcess(
	argv: readonly string[] = process.argv,
	cwd: string = process.cwd(),
): ProfileAliasCommand {
	const runtime = argv[0];
	const script = argv[1];
	if (!runtime || !script || !/\.[cm]?[jt]s$/.test(script)) return DEFAULT_ALIAS_COMMAND;

	const scriptPath = path.resolve(cwd, script);
	const posix = `${quoteForShell(runtime)} ${quoteForShell(scriptPath)}`;
	return {
		display: `${runtime} ${scriptPath}`,
		posix,
		fish: posix,
		powerShell: `${quoteForPowerShell(runtime)} ${quoteForPowerShell(scriptPath)}`,
	};
}

function resolveShellConfigPath(
	shell: ProfileAliasShell,
	homeDir: string,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string {
	switch (shell) {
		case "zsh":
			return path.join(env.ZDOTDIR || homeDir, ".zshrc");
		case "bash":
			return platform === "darwin" ? path.join(homeDir, ".bash_profile") : path.join(homeDir, ".bashrc");
		case "fish": {
			// fish sources conf.d from $XDG_CONFIG_HOME/fish (default ~/.config/fish);
			// a hard-coded ~/.config would be silently ignored when the user relocates
			// their XDG config root, leaving the alias unsourced after a restart.
			const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
			return path.join(configHome, "fish", "conf.d", "omp-profiles.fish");
		}
		case "pwsh":
			return platform === "win32"
				? path.join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")
				: path.join(homeDir, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
		case "powershell":
			return path.join(homeDir, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
	}
}

function renderAliasBlock(
	shell: ProfileAliasShell,
	aliasName: string,
	profile: string,
	command: ProfileAliasCommand,
): { block: string; command: string } {
	const profiledCommand = `${command.display} --profile=${profile}`;
	const start = `# >>> omp profile alias: ${aliasName} >>>`;
	const end = `# <<< omp profile alias: ${aliasName} <<<`;
	let body: string;
	switch (shell) {
		case "fish":
			body = [
				`function ${aliasName} --wraps omp --description 'OMP profile ${profile}'`,
				`    command ${command.fish} --profile=${profile} $argv`,
				"end",
			].join("\n");
			break;
		case "powershell":
		case "pwsh":
			body = [`function ${aliasName} {`, `    & ${command.powerShell} --profile=${profile} @args`, "}"].join("\n");
			break;
		default:
			body = [`${aliasName}() {`, `    command ${command.posix} --profile=${profile} "$@"`, "}"].join("\n");
			break;
	}
	return { block: `${start}\n${body}\n${end}`, command: profiledCommand };
}

function upsertBlock(content: string, aliasName: string, block: string): string {
	const start = `# >>> omp profile alias: ${aliasName} >>>`;
	const end = `# <<< omp profile alias: ${aliasName} <<<`;
	const startIndex = content.indexOf(start);
	if (startIndex !== -1) {
		const endIndex = content.indexOf(end, startIndex + start.length);
		if (endIndex === -1) {
			throw new Error(
				`Found "${start}" without a matching "${end}" in the shell config. ` +
					`The managed alias block is malformed; remove the stale marker line and rerun --alias.`,
			);
		}
		const afterEnd = endIndex + end.length;
		const prefix = content.slice(0, startIndex).replace(/[\t ]*\n?$/, "");
		const suffix = content.slice(afterEnd).replace(/^\n?/, "");
		return [prefix, block, suffix].filter(Boolean).join("\n\n").replace(/\n*$/, "\n");
	}
	const trimmed = content.replace(/\s*$/, "");
	return `${trimmed}${trimmed ? "\n\n" : ""}${block}\n`;
}

function readAliasConfigText(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

export async function readProfileAliasConfigFile(
	filePath: string,
	readText: (filePath: string) => Promise<string> = readAliasConfigText,
): Promise<string> {
	try {
		return await readText(filePath);
	} catch (error) {
		if (isEnoentError(error)) return "";
		throw error;
	}
}

export async function installProfileAlias(options: ProfileAliasInstallOptions): Promise<ProfileAliasInstallResult> {
	const profile = normalizeProfileName(options.profile);
	if (!profile) {
		throw new Error("--alias requires a named --profile value.");
	}
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const env = options.env ?? process.env;
	const shell = normalizeShellName(options.shellPath ?? env.SHELL, platform, env);
	const aliasName = validateAliasName(options.aliasName, shell);
	const configPath = resolveShellConfigPath(shell, homeDir, platform, env);
	const { block, command } = renderAliasBlock(shell, aliasName, profile, options.command ?? DEFAULT_ALIAS_COMMAND);
	const readFile = options.readFile ?? readProfileAliasConfigFile;
	const writeFile =
		options.writeFile ??
		(async (filePath, content) => {
			await Bun.write(filePath, content);
		});

	const current = await readFile(configPath);
	await writeFile(configPath, upsertBlock(current, aliasName, block));

	return {
		shell,
		configPath,
		aliasName,
		profile,
		command,
		reloadedWith:
			shell === "fish"
				? `source ${quoteForShell(configPath)}`
				: shell === "powershell" || shell === "pwsh"
					? `. ${quoteForPowerShell(configPath)}`
					: `. ${quoteForShell(configPath)}`,
	};
}
