/**
 * Setup CLI command handler.
 *
 * Handles `omp setup <component>` to install dependencies for optional features.
 */
import * as path from "node:path";
import { $which, APP_NAME, getPythonEnvDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";

export type SetupComponent = "python" | "stt";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["python", "stt"];

const PYTHON_PACKAGES = ["jupyter_kernel_gateway", "ipykernel"];
const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(`Usage: ${APP_NAME} setup <component>`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(`Unknown component: ${component}`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	uvPath?: string;
	pipPath?: string;
	missingPackages: string[];
	installedPackages: string[];
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
async function checkPythonSetup(): Promise<PythonCheckResult> {
	const result: PythonCheckResult = {
		available: false,
		missingPackages: [],
		installedPackages: [],
		managedEnvPath: MANAGED_PYTHON_ENV,
	};

	const systemPythonPath = $which("python") ?? $which("python3");
	const managedPath = managedPythonPath();
	const hasManagedEnv = await Bun.file(managedPath).exists();

	result.uvPath = $which("uv") ?? undefined;
	result.pipPath = $which("pip3") ?? $which("pip") ?? undefined;

	const candidates = [systemPythonPath, hasManagedEnv ? managedPath : undefined].filter(
		(candidate): candidate is string => !!candidate,
	);
	if (candidates.length === 0) {
		return result;
	}

	result.pythonPath = systemPythonPath ?? managedPath;
	let bestMatch = {
		pythonPath: candidates[0],
		missingPackages: [...PYTHON_PACKAGES],
		installedPackages: [] as string[],
		usingManagedEnv: candidates[0] === managedPath,
	};

	for (const pythonPath of candidates) {
		const installedPackages: string[] = [];
		const missingPackages: string[] = [];
		for (const pkg of PYTHON_PACKAGES) {
			const moduleName = pkg === "jupyter_kernel_gateway" ? "kernel_gateway" : pkg;
			const script = `import importlib.util; raise SystemExit(0 if importlib.util.find_spec('${moduleName}') else 1)`;
			const check = await $`${pythonPath} -c ${script}`.quiet().nothrow();
			if (check.exitCode === 0) {
				installedPackages.push(pkg);
			} else {
				missingPackages.push(pkg);
			}
		}

		if (missingPackages.length < bestMatch.missingPackages.length) {
			bestMatch = {
				pythonPath,
				missingPackages,
				installedPackages,
				usingManagedEnv: pythonPath === managedPath,
			};
		}

		if (missingPackages.length === 0) {
			result.available = true;
			result.pythonPath = pythonPath;
			result.missingPackages = missingPackages;
			result.installedPackages = installedPackages;
			result.usingManagedEnv = pythonPath === managedPath;
			return result;
		}
	}

	result.pythonPath = bestMatch.pythonPath;
	result.missingPackages = bestMatch.missingPackages;
	result.installedPackages = bestMatch.installedPackages;
	result.usingManagedEnv = bestMatch.usingManagedEnv;
	return result;
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
async function installPythonPackages(
	packages: string[],
	pythonPath: string,
	uvPath?: string,
	pipPath?: string,
): Promise<{ success: boolean; usedManagedEnv: boolean }> {
	if (uvPath) {
		console.log(chalk.dim(`Installing via uv: ${packages.join(" ")}`));
		const result = await $`${uvPath} pip install ${packages}`.nothrow();
		if (result.exitCode === 0) {
			return { success: true, usedManagedEnv: false };
		}
	}

	if (pipPath) {
		console.log(chalk.dim(`Installing via pip: ${packages.join(" ")}`));
		const result = await $`${pipPath} install ${packages}`.nothrow();
		if (result.exitCode === 0) {
			return { success: true, usedManagedEnv: false };
		}
	}

	console.log(chalk.dim(`Falling back to managed virtual environment: ${MANAGED_PYTHON_ENV}`));

	if (uvPath) {
		const createEnv = await $`${uvPath} venv ${MANAGED_PYTHON_ENV}`.quiet().nothrow();
		if (createEnv.exitCode !== 0) {
			return { success: false, usedManagedEnv: true };
		}
		const installInManagedEnv = await $`${uvPath} pip install --python ${MANAGED_PYTHON_ENV} ${packages}`.nothrow();
		return { success: installInManagedEnv.exitCode === 0, usedManagedEnv: true };
	}

	const createEnv = await $`${pythonPath} -m venv ${MANAGED_PYTHON_ENV}`.quiet().nothrow();
	if (createEnv.exitCode !== 0) {
		return { success: false, usedManagedEnv: true };
	}

	const managedPython = managedPythonPath();
	const installInManagedEnv = await $`${managedPython} -m pip install ${packages}`.nothrow();
	return { success: installInManagedEnv.exitCode === 0, usedManagedEnv: true };
}

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "stt":
			await handleSttSetup(cmd.flags);
			break;
	}
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const check = await checkPythonSetup();

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(`${theme.status.error} Python not found`));
		console.error(chalk.dim("Install Python 3.8+ and ensure it's in your PATH"));
		process.exit(1);
	}

	console.log(chalk.dim(`Python: ${check.pythonPath}`));
	if (check.usingManagedEnv) {
		console.log(chalk.dim(`Using managed environment: ${check.managedEnvPath}`));
	}

	if (check.uvPath) {
		console.log(chalk.dim(`uv: ${check.uvPath}`));
	} else if (check.pipPath) {
		console.log(chalk.dim(`pip: ${check.pipPath}`));
	}

	if (check.installedPackages.length > 0) {
		console.log(chalk.green(`${theme.status.success} Installed: ${check.installedPackages.join(", ")}`));
	}

	if (check.missingPackages.length === 0) {
		console.log(chalk.green(`\n${theme.status.success} Python execution is ready`));
		return;
	}

	console.log(chalk.yellow(`${theme.status.warning} Missing: ${check.missingPackages.join(", ")}`));

	if (flags.check) {
		process.exit(1);
	}

	if (!check.uvPath && !check.pipPath) {
		console.error(chalk.red(`\n${theme.status.error} No package manager found`));
		console.error(chalk.dim("Install uv (recommended) or pip:"));
		console.error(chalk.dim("  curl -LsSf https://astral.sh/uv/install.sh | sh"));
		process.exit(1);
	}

	console.log("");
	const install = await installPythonPackages(check.missingPackages, check.pythonPath, check.uvPath, check.pipPath);

	if (!install.success) {
		console.error(chalk.red(`\n${theme.status.error} Installation failed`));
		console.error(chalk.dim("Try installing manually:"));
		if (install.usedManagedEnv) {
			if (check.uvPath) {
				console.error(chalk.dim(`  uv venv ${MANAGED_PYTHON_ENV}`));
				console.error(
					chalk.dim(`  uv pip install --python ${MANAGED_PYTHON_ENV} ${check.missingPackages.join(" ")}`),
				);
			} else {
				console.error(chalk.dim(`  ${check.pythonPath} -m venv ${MANAGED_PYTHON_ENV}`));
				console.error(chalk.dim(`  ${managedPythonPath()} -m pip install ${check.missingPackages.join(" ")}`));
			}
		} else {
			console.error(chalk.dim(`  ${check.uvPath ? "uv pip" : "pip"} install ${check.missingPackages.join(" ")}`));
		}
		process.exit(1);
	}

	const recheck = await checkPythonSetup();
	if (recheck.available) {
		console.log(chalk.green(`\n${theme.status.success} Python execution is ready`));
		if (recheck.usingManagedEnv) {
			console.log(chalk.dim(`Managed Python environment: ${recheck.managedEnvPath}`));
		}
	} else {
		console.error(chalk.red(`\n${theme.status.error} Setup incomplete`));
		console.error(chalk.dim(`Still missing: ${recheck.missingPackages.join(", ")}`));
		process.exit(1);
	}
}

async function handleSttSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const { checkDependencies, formatDependencyStatus } = await import("../stt/setup");
	const status = await checkDependencies();

	if (flags.json) {
		console.log(JSON.stringify(status, null, 2));
		if (!status.recorder.available || !status.python.available || !status.whisper.available) process.exit(1);
		return;
	}

	console.log(formatDependencyStatus(status));

	if (status.recorder.available && status.python.available && status.whisper.available) {
		console.log(chalk.green(`\n${theme.status.success} Speech-to-text is ready`));
		return;
	}

	if (flags.check) {
		process.exit(1);
	}

	if (!status.python.available) {
		console.error(chalk.red(`\n${theme.status.error} Python not found`));
		console.error(chalk.dim("Install Python 3.8+ and ensure it's in your PATH"));
		process.exit(1);
	}

	if (!status.recorder.available) {
		console.error(chalk.yellow(`\n${theme.status.warning} No recording tool found`));
		console.error(chalk.dim(status.recorder.installHint));
	}

	if (!status.whisper.available) {
		console.log(chalk.dim(`\nInstalling openai-whisper...`));
		const { resolvePython } = await import("../stt/transcriber");
		const pythonCmd = resolvePython()!;
		const result = await $`${pythonCmd} -m pip install -q openai-whisper`.nothrow();
		if (result.exitCode !== 0) {
			console.error(chalk.red(`\n${theme.status.error} Failed to install openai-whisper`));
			console.error(chalk.dim("Try manually: pip install openai-whisper"));
			process.exit(1);
		}
	}

	const recheck = await checkDependencies();
	if (recheck.recorder.available && recheck.python.available && recheck.whisper.available) {
		console.log(chalk.green(`\n${theme.status.success} Speech-to-text is ready`));
	} else {
		console.error(chalk.red(`\n${theme.status.error} Setup incomplete`));
		console.log(formatDependencyStatus(recheck));
		process.exit(1);
	}
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} setup`)} - Install dependencies for optional features

${chalk.bold("Usage:")}
  ${APP_NAME} setup <component> [options]

${chalk.bold("Components:")}
  python    Install Jupyter kernel dependencies for Python code execution
  stt       Install speech-to-text dependencies (openai-whisper, recording tools)
            Packages: ${PYTHON_PACKAGES.join(", ")}

${chalk.bold("Options:")}
  -c, --check   Check if dependencies are installed without installing
  --json        Output status as JSON

${chalk.bold("Examples:")}
  ${APP_NAME} setup python           Install Python execution dependencies
  ${APP_NAME} setup stt              Install speech-to-text dependencies
  ${APP_NAME} setup stt --check      Check if STT dependencies are available
  ${APP_NAME} setup python --check   Check if Python execution is available
`);
}
