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
		managedEnvPath: MANAGED_PYTHON_ENV,
	};

	const systemPythonPath = $which("python") ?? $which("python3");
	const managedPath = managedPythonPath();
	const hasManagedEnv = await Bun.file(managedPath).exists();

	const pythonPath = systemPythonPath ?? (hasManagedEnv ? managedPath : undefined);
	if (!pythonPath) {
		return result;
	}
	const probe = await $`${pythonPath} -c "import sys;sys.exit(0)"`.quiet().nothrow();
	result.pythonPath = pythonPath;
	result.available = probe.exitCode === 0;
	result.usingManagedEnv = pythonPath === managedPath;
	return result;
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `omp setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

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

	if (check.available) {
		console.log(chalk.green(`\n${theme.status.success} Python execution is ready`));
		return;
	}

	console.error(chalk.red(`\n${theme.status.error} Python interpreter reported failure`));
	process.exit(1);
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
  python    Verify a Python 3 interpreter is reachable for code execution
  stt       Install speech-to-text dependencies (openai-whisper, recording tools)

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
