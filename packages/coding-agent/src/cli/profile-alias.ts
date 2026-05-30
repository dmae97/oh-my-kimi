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

export interface ProfileAliasInstallOptions {
	profile: string;
	aliasName: string;
	shellPath?: string;
	platform?: NodeJS.Platform;
	homeDir?: string;
	readFile?: (filePath: string) => Promise<string>;
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

// Keep local: importing the pi-utils root here would eagerly load env before
// cli.ts has applied --profile, regressing profile-specific .env loading.
function isEnoentError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function validateAliasName(aliasName: string): string {
	const normalized = aliasName.trim();
	if (!ALIAS_NAME_RE.test(normalized)) {
		throw new Error(`Invalid alias "${aliasName}". Alias names must match ${ALIAS_NAME_RE.source}.`);
	}
	if (normalized.toLowerCase() === "omp") {
		throw new Error('Invalid alias "omp". Refusing to shadow the base omp command.');
	}
	return normalized;
}

function normalizeShellName(shellPath: string | undefined, platform: NodeJS.Platform): ProfileAliasShell {
	const shell = path
		.basename(shellPath ?? "")
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (shell === "zsh") return "zsh";
	if (shell === "bash") return "bash";
	if (shell === "fish") return "fish";
	if (shell === "pwsh") return "pwsh";
	if (shell === "powershell") return "powershell";
	if (platform === "win32") return process.env.POWERSHELL_DISTRIBUTION_CHANNEL ? "pwsh" : "powershell";
	throw new Error(`Unsupported shell${shell ? ` "${shell}"` : ""}. Supported shells: bash, zsh, fish, PowerShell.`);
}

function resolveShellConfigPath(shell: ProfileAliasShell, homeDir: string, platform: NodeJS.Platform): string {
	switch (shell) {
		case "zsh":
			return path.join(homeDir, ".zshrc");
		case "bash":
			return platform === "darwin" ? path.join(homeDir, ".bash_profile") : path.join(homeDir, ".bashrc");
		case "fish":
			return path.join(homeDir, ".config", "fish", "conf.d", "omp-profiles.fish");
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
): { block: string; command: string } {
	const command = `omp --profile ${profile}`;
	const start = `# >>> omp profile alias: ${aliasName} >>>`;
	const end = `# <<< omp profile alias: ${aliasName} <<<`;
	let body: string;
	switch (shell) {
		case "fish":
			body = [
				`function ${aliasName} --wraps omp --description 'OMP profile ${profile}'`,
				`    command ${command} $argv`,
				"end",
			].join("\n");
			break;
		case "powershell":
		case "pwsh":
			body = [`function ${aliasName} {`, `    & omp --profile ${profile} @args`, "}"].join("\n");
			break;
		default:
			body = `alias ${aliasName}='command ${command}'`;
			break;
	}
	return { block: `${start}\n${body}\n${end}`, command };
}

function upsertBlock(content: string, aliasName: string, block: string): string {
	const start = `# >>> omp profile alias: ${aliasName} >>>`;
	const end = `# <<< omp profile alias: ${aliasName} <<<`;
	const startIndex = content.indexOf(start);
	if (startIndex !== -1) {
		const endIndex = content.indexOf(end, startIndex + start.length);
		if (endIndex !== -1) {
			const afterEnd = endIndex + end.length;
			const prefix = content.slice(0, startIndex).replace(/[\t ]*\n?$/, "");
			const suffix = content.slice(afterEnd).replace(/^\n?/, "");
			return [prefix, block, suffix].filter(Boolean).join("\n\n").replace(/\n*$/, "\n");
		}
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
	const aliasName = validateAliasName(options.aliasName);
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const shell = normalizeShellName(options.shellPath ?? process.env.SHELL, platform);
	const configPath = resolveShellConfigPath(shell, homeDir, platform);
	const { block, command } = renderAliasBlock(shell, aliasName, profile);
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
