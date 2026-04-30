/**
 * Jupyter CLI command handlers.
 *
 * Handles `omp jupyter` subcommand for managing the shared Python gateway.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { getGatewayStatus, shutdownSharedGateway } from "../eval/py/gateway-coordinator";

export type JupyterAction = "kill" | "status";

export interface JupyterCommandArgs {
	action: JupyterAction;
}

export function parseJupyterArgs(args: string[]): JupyterCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "jupyter") {
		return undefined;
	}

	const action = args[1] as JupyterAction | undefined;
	if (!action || !["kill", "status"].includes(action)) {
		return { action: "status" };
	}

	return { action };
}

export async function runJupyterCommand(cmd: JupyterCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "kill":
			await runKill();
			break;
		case "status":
			await runStatus();
			break;
	}
}

async function runKill(): Promise<void> {
	const status = await getGatewayStatus();

	if (!status.active) {
		console.log(chalk.dim("No Jupyter gateway is running"));
		return;
	}

	console.log(`Killing Jupyter gateway (PID ${status.pid})...`);
	await shutdownSharedGateway();
	console.log(chalk.green("Jupyter gateway stopped"));
}

async function runStatus(): Promise<void> {
	const status = await getGatewayStatus();

	if (!status.active) {
		console.log(chalk.dim("No Jupyter gateway is running"));
		return;
	}

	console.log(chalk.bold("Jupyter Gateway Status\n"));
	console.log(`  ${chalk.green("●")} Running`);
	console.log(`  PID:    ${status.pid}`);
	console.log(`  URL:    ${status.url}`);
	if (status.uptime !== null) {
		console.log(`  Uptime: ${formatUptime(status.uptime)}`);
	}
	if (status.pythonPath) {
		console.log(`  Python: ${status.pythonPath}`);
	}
	if (status.venvPath) {
		console.log(`  Venv:   ${status.venvPath}`);
	}
}

function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${seconds}s`;
}

export function printJupyterHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} jupyter`)} - Manage the shared Jupyter gateway

${chalk.bold("Usage:")}
  ${APP_NAME} jupyter <command>

${chalk.bold("Commands:")}
  status    Show gateway status (default)
  kill      Stop the running gateway

${chalk.bold("Examples:")}
  ${APP_NAME} jupyter           # Show status
  ${APP_NAME} jupyter status    # Show status
  ${APP_NAME} jupyter kill      # Stop the gateway
`);
}
