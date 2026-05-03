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

export interface CleanGrievancesOptions {
	/** Delete a single grievance by id. */
	id?: number;
	/** Delete every grievance recorded for this tool name. */
	tool?: string;
	/** Delete every grievance regardless of tool/id. */
	all?: boolean;
	/** Output the deletion count as JSON instead of a status message. */
	json?: boolean;
}

function openDb(readonly: boolean): Database | null {
	try {
		// bun:sqlite rejects `{ readonly: false }` — it requires either readonly,
		// readwrite, or create flags to be explicit. Use the default constructor
		// (readwrite + create) for write mode and only pass `readonly: true` when
		// listing.
		return readonly ? new Database(getAutoQaDbPath(), { readonly: true }) : new Database(getAutoQaDbPath());
	} catch {
		return null;
	}
}

export async function listGrievances(options: ListGrievancesOptions): Promise<void> {
	const db = openDb(true);
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

/**
 * Delete grievances from the auto-QA database.
 *
 * Selectors are mutually exclusive in intent — exactly one of `id`, `tool`, or
 * `all` is required. Multiple selectors are rejected to prevent ambiguous deletes
 * (e.g. `--id 5 --all` would be a footgun). Returns silently when the database
 * does not exist yet.
 */
export async function cleanGrievances(options: CleanGrievancesOptions): Promise<void> {
	const selectors = [options.id !== undefined, !!options.tool, !!options.all].filter(Boolean).length;
	if (selectors === 0) {
		console.error(chalk.red("Specify exactly one of --id, --tool, or --all."));
		process.exitCode = 1;
		return;
	}
	if (selectors > 1) {
		console.error(chalk.red("--id, --tool, and --all are mutually exclusive."));
		process.exitCode = 1;
		return;
	}

	const db = openDb(false);
	if (!db) {
		if (options.json) {
			console.log(JSON.stringify({ deleted: 0 }));
		} else {
			console.log(
				chalk.dim("No grievances database found. Enable auto-QA with PI_AUTO_QA=1 or the dev.autoqa setting."),
			);
		}
		return;
	}

	try {
		let deleted = 0;
		if (options.id !== undefined) {
			const result = db.prepare("DELETE FROM grievances WHERE id = ?").run(options.id);
			deleted = Number(result.changes);
		} else if (options.tool) {
			const result = db.prepare("DELETE FROM grievances WHERE tool = ?").run(options.tool);
			deleted = Number(result.changes);
		} else {
			const result = db.prepare("DELETE FROM grievances").run();
			deleted = Number(result.changes);
			// Reset the autoincrement counter so a fresh slate starts at #1 again.
			// `sqlite_sequence` only exists if AUTOINCREMENT was ever used; ignore failures.
			try {
				db.prepare("DELETE FROM sqlite_sequence WHERE name = 'grievances'").run();
			} catch {
				/* sequence table missing on a brand-new db — nothing to reset */
			}
		}

		if (options.json) {
			console.log(JSON.stringify({ deleted }));
			return;
		}

		if (deleted === 0) {
			console.log(chalk.dim("No matching grievances to delete."));
			return;
		}

		const scope =
			options.id !== undefined ? `#${options.id}` : options.tool ? `for ${options.tool}` : "(all entries)";
		console.log(chalk.green(`Deleted ${deleted} grievance${deleted === 1 ? "" : "s"} ${scope}.`));
	} finally {
		db.close();
	}
}
