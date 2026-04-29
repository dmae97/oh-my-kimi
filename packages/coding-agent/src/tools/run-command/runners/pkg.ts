import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { DetectedRunner, RunnerTask, TaskRunner } from "../runner";

interface PackageJsonInfo {
	name?: string;
	scripts: string[];
	workspaces: string[];
}

interface PackageCommandInfo {
	rootCommandPrefix: string;
	workspaceCommandPrefix: (relativeDir: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function resolvePackageRunner(cwd: string): Promise<PackageCommandInfo> {
	if ((await isFile(path.join(cwd, "bun.lock"))) || (await isFile(path.join(cwd, "bun.lockb")))) {
		return {
			rootCommandPrefix: "bun run",
			workspaceCommandPrefix: relativeDir => `bun --cwd ${shellQuote(relativeDir)} run`,
		};
	}
	if (await isFile(path.join(cwd, "pnpm-lock.yaml"))) {
		return {
			rootCommandPrefix: "pnpm run",
			workspaceCommandPrefix: relativeDir => `pnpm --dir ${shellQuote(relativeDir)} run`,
		};
	}
	if (await isFile(path.join(cwd, "yarn.lock"))) {
		return {
			rootCommandPrefix: "yarn",
			workspaceCommandPrefix: relativeDir => `yarn --cwd ${shellQuote(relativeDir)}`,
		};
	}
	if ((await isFile(path.join(cwd, "package-lock.json"))) || (await isFile(path.join(cwd, "npm-shrinkwrap.json")))) {
		return {
			rootCommandPrefix: "npm run",
			workspaceCommandPrefix: relativeDir => `npm --prefix ${shellQuote(relativeDir)} run`,
		};
	}
	if ($which("bun")) {
		return {
			rootCommandPrefix: "bun run",
			workspaceCommandPrefix: relativeDir => `bun --cwd ${shellQuote(relativeDir)} run`,
		};
	}
	return {
		rootCommandPrefix: "npm run",
		workspaceCommandPrefix: relativeDir => `npm --prefix ${shellQuote(relativeDir)} run`,
	};
}

function parseWorkspacePatterns(pkg: Record<string, unknown>): string[] {
	const { workspaces } = pkg;
	if (Array.isArray(workspaces)) return workspaces.filter((entry): entry is string => typeof entry === "string");
	if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
		return workspaces.packages.filter((entry): entry is string => typeof entry === "string");
	}
	return [];
}

function normalizeWorkspacePattern(pattern: string): string {
	const negated = pattern.startsWith("!");
	const body = negated ? pattern.slice(1) : pattern;
	const normalizedBody = body.endsWith("package.json") ? body : `${body.replace(/\/+$/u, "")}/package.json`;
	return negated ? `!${normalizedBody}` : normalizedBody;
}

async function readPackageJson(filePath: string): Promise<PackageJsonInfo | null> {
	try {
		const pkg = (await Bun.file(filePath).json()) as unknown;
		if (!isRecord(pkg)) return null;
		const scripts = isRecord(pkg.scripts)
			? Object.entries(pkg.scripts)
					.filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].length > 0)
					.map(([name]) => name)
			: [];
		const name = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : undefined;
		return { name, scripts, workspaces: parseWorkspacePatterns(pkg) };
	} catch (err) {
		if (!isEnoent(err)) {
			logger.debug("package.json script detection failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return null;
	}
}

async function findWorkspacePackageJsons(cwd: string, patterns: string[]): Promise<string[]> {
	const includePatterns = patterns.filter(pattern => !pattern.startsWith("!")).map(normalizeWorkspacePattern);
	const excludePatterns = patterns.filter(pattern => pattern.startsWith("!")).map(normalizeWorkspacePattern);
	const excluded = new Set<string>();
	for (const pattern of excludePatterns) {
		for await (const entry of new Bun.Glob(pattern.slice(1)).scan({ cwd, onlyFiles: true })) {
			excluded.add(path.normalize(String(entry)));
		}
	}
	const files = new Set<string>();
	for (const pattern of includePatterns) {
		for await (const entry of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
			const normalized = path.normalize(String(entry));
			if (normalized !== "package.json" && !excluded.has(normalized)) files.add(normalized);
		}
	}
	return [...files].sort((left, right) => left.localeCompare(right));
}

function packageTaskName(packageName: string | undefined, packageDir: string, scriptName: string): string {
	return `${packageName ?? packageDir}/${scriptName}`;
}

function tasksForPackage(options: {
	pkg: PackageJsonInfo;
	packageDir: string;
	commandPrefix: string;
	namespaced: boolean;
}): RunnerTask[] {
	return options.pkg.scripts.map(scriptName => ({
		name: options.namespaced ? packageTaskName(options.pkg.name, options.packageDir, scriptName) : scriptName,
		doc: options.namespaced ? options.packageDir : undefined,
		parameters: [],
		commandPrefix: options.commandPrefix,
		commandName: shellQuote(scriptName),
	}));
}

async function readPackageTasks(cwd: string, commandInfo: PackageCommandInfo): Promise<RunnerTask[] | null> {
	const rootPkg = await readPackageJson(path.join(cwd, "package.json"));
	if (!rootPkg) return null;
	const workspacePackageJsons = await findWorkspacePackageJsons(cwd, rootPkg.workspaces);
	const isMonorepo = workspacePackageJsons.length > 0;
	const tasks: RunnerTask[] = [];

	if (rootPkg.scripts.length > 0) {
		tasks.push(
			...tasksForPackage({
				pkg: rootPkg,
				packageDir: ".",
				commandPrefix: commandInfo.rootCommandPrefix,
				namespaced: isMonorepo,
			}),
		);
	}

	for (const packageJsonPath of workspacePackageJsons) {
		const pkg = await readPackageJson(path.join(cwd, packageJsonPath));
		if (!pkg || pkg.scripts.length === 0) continue;
		const packageDir = path.dirname(packageJsonPath);
		tasks.push(
			...tasksForPackage({
				pkg,
				packageDir,
				commandPrefix: commandInfo.workspaceCommandPrefix(packageDir),
				namespaced: true,
			}),
		);
	}

	return tasks.length > 0 ? tasks : null;
}

export const pkgRunner: TaskRunner = {
	id: "pkg",
	label: "Pkg",
	async detect(cwd: string): Promise<DetectedRunner | null> {
		try {
			const commandInfo = await resolvePackageRunner(cwd);
			const tasks = await readPackageTasks(cwd, commandInfo);
			if (!tasks || tasks.length === 0) return null;
			return { id: "pkg", label: "Pkg", commandPrefix: commandInfo.rootCommandPrefix, tasks };
		} catch (err) {
			logger.debug("package runner probe failed", { error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	},
};
