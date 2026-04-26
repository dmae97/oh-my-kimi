/**
 * report_tool_issue — automated QA tool for tracking unexpected tool behavior.
 *
 * Enabled when PI_AUTO_QA=1 or the dev.autoqa setting is on.
 * Always injected into every agent (including subagents) regardless of tool selection.
 * Records grievances to a local SQLite database; never throws.
 */
import { Database } from "bun:sqlite";
import path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { $flag, getAgentDir, logger, VERSION } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { Settings } from "..";
import type { ToolSession } from "./index";

const ReportToolIssueParams = Type.Object({
	tool: Type.String({ description: "tool name", examples: ["bash", "read"] }),
	report: Type.String({ description: "unexpected behavior" }),
});

export function isAutoQaEnabled(settings?: Settings): boolean {
	return $flag("PI_AUTO_QA") || !!settings?.get("dev.autoqa");
}

export function getAutoQaDbPath(): string {
	return path.join(getAgentDir(), "autoqa.db");
}

let cachedDb: Database | null = null;

function openDb(): Database | null {
	if (cachedDb) return cachedDb;
	try {
		const db = new Database(getAutoQaDbPath());
		db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL
			);
		`);
		cachedDb = db;
		return db;
	} catch {
		return null;
	}
}

export function createReportToolIssueTool(session: ToolSession): AgentTool {
	const getModel = () => session.getActiveModelString?.() ?? "unknown";

	return {
		name: "report_tool_issue",
		label: "Report Tool Issue",
		strict: false,
		description: "Report unexpected tool behavior for automated QA tracking.",
		parameters: ReportToolIssueParams,
		nointent: true,
		async execute(_toolCallId, rawParams) {
			try {
				const params = rawParams as { tool: string; report: string };
				const db = openDb();
				db?.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)").run(
					getModel(),
					VERSION,
					params.tool,
					params.report,
				);
			} catch (error) {
				logger.error("Failed to record tool issue", { error });
			}
			return {
				content: [{ type: "text", text: "Noted, thanks!" }],
			};
		},
	};
}
