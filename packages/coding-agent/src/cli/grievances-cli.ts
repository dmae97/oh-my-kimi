/**
 * CLI handler for `omp grievances` — view reported tool issues from auto-QA.
 */
import { Database } from "bun:sqlite";
import chalk from "chalk";
import { getAutoQaDbPath } from "../tools/report-tool-issue";

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
}

export interface ListGrievancesOptions {
	limit: number;
	tool?: string;
	json: boolean;
}

function openDb(): Database | null {
	try {
		const db = new Database(getAutoQaDbPath(), { readonly: true });
		return db;
	} catch {
		return null;
	}
}

export async function listGrievances(options: ListGrievancesOptions): Promise<void> {
	const db = openDb();
	if (!db) {
		if (options.json) {
			console.log("[]");
		} else {
			console.log(
				chalk.dim("No grievances database found. Enable auto-QA with PI_AUTO_QA=1 or the dev.autoqa setting."),
			);
		}
		return;
	}

	try {
		let rows: GrievanceRow[];
		if (options.tool) {
			rows = db
				.prepare("SELECT id, model, version, tool, report FROM grievances WHERE tool = ? ORDER BY id DESC LIMIT ?")
				.all(options.tool, options.limit) as GrievanceRow[];
		} else {
			rows = db
				.prepare("SELECT id, model, version, tool, report FROM grievances ORDER BY id DESC LIMIT ?")
				.all(options.limit) as GrievanceRow[];
		}

		if (options.json) {
			console.log(JSON.stringify(rows, null, 2));
			return;
		}

		if (rows.length === 0) {
			console.log(chalk.dim("No grievances recorded yet."));
			return;
		}

		for (const row of rows) {
			console.log(
				`${chalk.dim(`#${row.id}`)} ${chalk.cyan(row.tool)} ${chalk.dim(`(${row.model} v${row.version})`)}`,
			);
			console.log(`  ${row.report}`);
			console.log();
		}

		console.log(chalk.dim(`Showing ${rows.length} most recent${options.tool ? ` for ${options.tool}` : ""}`));
	} finally {
		db.close();
	}
}
