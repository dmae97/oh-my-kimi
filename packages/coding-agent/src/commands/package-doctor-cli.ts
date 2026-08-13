import { APP_NAME, getAgentDir } from "../config.ts";
import { inspectPackageCompatibility, type PackageDoctorResult } from "../core/package-doctor.ts";
import { DefaultPackageManager, type PackageInspection, type ResolvedResource } from "../core/package-manager.ts";
import { redactSensitiveTextForced } from "../core/redaction.ts";
import { SettingsManager } from "../core/settings-manager.ts";

export interface PackageDoctorCliOutcome {
	handled: boolean;
	exitCode: number;
}

export interface PackageDoctorCliDependencies {
	cwd?: string;
	agentDir?: string;
	writeLine?: (line: string) => void;
	prepare?: (source: string) => Promise<PackageInspection>;
}

function usage(): string {
	return `Usage: ${APP_NAME} package doctor <source>\n\nStatically inspects package.json manifest precedence and extension compatibility.\nRemote npm packages are packed and boundedly extracted without dependency installation or lifecycle scripts.\nThe doctor never imports or executes extension modules.`;
}

function writeJson(writeLine: (line: string) => void, value: unknown): void {
	writeLine(JSON.stringify(value, null, 2));
}

function sanitizeFailureMessage(message: string): string {
	return redactSensitiveTextForced(message).replace(
		/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu,
		(_match, protocol: string) => `${protocol}[REDACTED]@`,
	);
}

function usageError(writeLine: (line: string) => void): PackageDoctorCliOutcome {
	writeJson(writeLine, {
		schemaVersion: 1,
		error: { code: "cli-usage", message: `Expected: ${APP_NAME} package doctor <source>` },
	});
	return { handled: true, exitCode: 2 };
}

function enabledPaths(resources: ResolvedResource[]): string[] {
	const paths: string[] = [];
	for (const resource of resources) {
		if (resource.enabled) paths.push(resource.path);
	}
	return paths;
}

function resourcePaths(inspection: PackageInspection): {
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
} {
	return {
		extensions: enabledPaths(inspection.resources.extensions),
		skills: enabledPaths(inspection.resources.skills),
		prompts: enabledPaths(inspection.resources.prompts),
		themes: enabledPaths(inspection.resources.themes),
	};
}

async function defaultPrepare(source: string, cwd: string, agentDir: string): Promise<PackageInspection> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	return packageManager.preparePackageInspection(source);
}

export async function runPackageDoctorCli(
	args: string[],
	dependencies: PackageDoctorCliDependencies = {},
): Promise<PackageDoctorCliOutcome> {
	if (args[0] !== "package" || args[1] !== "doctor") return { handled: false, exitCode: 0 };
	const writeLine = dependencies.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
	const rest = args.slice(2);
	if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
		writeLine(usage());
		return { handled: true, exitCode: 0 };
	}
	if (rest.length !== 1 || !rest[0] || rest[0].startsWith("-")) return usageError(writeLine);

	const source = rest[0];
	const cwd = dependencies.cwd ?? process.cwd();
	const agentDir = dependencies.agentDir ?? getAgentDir();
	let inspection: PackageInspection | undefined;
	try {
		inspection = await (dependencies.prepare ? dependencies.prepare(source) : defaultPrepare(source, cwd, agentDir));
		const result: PackageDoctorResult = inspectPackageCompatibility({
			source,
			packageRoot: inspection.packageRoot,
			resources: resourcePaths(inspection),
		});
		writeJson(writeLine, result);
		return { handled: true, exitCode: result.compatible ? 0 : 1 };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Package inspection failed";
		writeJson(writeLine, {
			schemaVersion: 1,
			error: { code: "package-doctor-failed", message: sanitizeFailureMessage(message) },
		});
		return { handled: true, exitCode: 1 };
	} finally {
		inspection?.cleanup?.();
	}
}
