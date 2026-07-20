/**
 * report_issue — automated QA backend for tracking unexpected tool behavior.
 *
 * No model-facing tool schema anymore: the write tool dispatches plain text to
 * `xd://report_issue`, and the system prompt tells the model to write
 * `<tool>: <concise description>` there when auto-QA is enabled.
 *
 * Enabled by default; gated behind PI_AUTO_QA=1 / `dev.autoqa` so a user who
 * flips the setting off short-circuits injection entirely.
 * Records grievances to a local SQLite database; never throws from the device
 * dispatch path.
 *
 * Before the first record lands, the user's consent is checked. If they've
 * never been asked (`dev.autoqaConsent === "unset"`) the process-global
 * consent handler — wired by `InteractiveMode` to a Yes/No popup — is invoked
 * exactly once and the decision is persisted. Subsequent calls (including from
 * subagents) read the cached decision without prompting.
 *
 * When the user grants consent, push is automatically active against the
 * bundled endpoint (`dev.autoqaPush.endpoint`, default `qa.omp.sh`). Each
 * insert schedules a background flush that POSTs pending rows and deletes them
 * on HTTP 2xx. `PI_AUTO_QA_PUSH=1` forces push in non-interactive environments
 * where the consent dialog never fires. Device execution is never blocked on
 * the network and never throws.
 */
import { Database } from "bun:sqlite";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { $env, $flag, getAutoQaDbDir, getInstallId, logger, VERSION } from "@oh-my-pi/pi-utils";
import type { Settings } from "..";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";
import type { XdevDispatch } from "./xdev";

export const REPORT_ISSUE_DEVICE_NAME = "report_issue";
export const REPORT_ISSUE_DEVICE_PATH = `xd://${REPORT_ISSUE_DEVICE_NAME}`;

/** Usage text for `read xd://report_issue`. */
export function reportIssueDeviceUsage(): string {
	return `Write \`<tool>: <concise description>\` as plain text to ${REPORT_ISSUE_DEVICE_PATH}. A two-line fallback also works: tool name on line 1, report body below.`;
}

/** Whether a tool call writes to `xd://report_issue`. */
export function isReportIssueToolCall(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean {
	if (toolCall.name !== "write") return false;
	const args = toolCall.arguments;
	const path =
		typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : undefined;
	return path === REPORT_ISSUE_DEVICE_PATH || path === `${REPORT_ISSUE_DEVICE_PATH}/`;
}

/** Call preview for an `xd://report_issue` write. */
export function renderReportIssueDeviceCall(content: unknown, uiTheme: Theme): Component {
	const body = typeof content === "string" ? replaceTabs(content.trim().split("\n")[0] ?? "") : "";
	const text = renderStatusLine(
		{
			icon: "pending",
			title: "Report Tool Issue",
			description: body ? truncateToWidth(body, 72) : undefined,
		},
		uiTheme,
	);
	return new Text(text, 0, 0);
}

function parseReportIssueBody(text: string): { tool: string; report: string } {
	const body = text.trim();
	if (!body) {
		throw new ToolError(`Empty report. ${reportIssueDeviceUsage()}`);
	}
	const firstNewline = body.indexOf("\n");
	if (firstNewline >= 0) {
		const tool = body.slice(0, firstNewline).trim();
		const report = body.slice(firstNewline + 1).trim();
		if (tool && report) return { tool, report };
	}
	const colon = body.indexOf(":");
	if (colon > 0) {
		const tool = body.slice(0, colon).trim();
		const report = body.slice(colon + 1).trim();
		if (tool && report) return { tool, report };
	}
	throw new ToolError(`Invalid report format. ${reportIssueDeviceUsage()}`);
}

export function isAutoQaEnabled(settings?: Settings): boolean {
	return $flag("PI_AUTO_QA", !!settings?.get("dev.autoqa"));
}

// ───────────────────────────────────────────────────────────────────────────
// Consent gate
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolver for the user's "share grievances?" consent.
 *
 * Return values:
 *   - `true`  — user agreed; record + ship for this run and persist.
 *   - `false` — user declined; suppress for this run and persist.
 *   - `null`  — user dismissed the dialog (ESC, click-away, …) without
 *               picking an option. The decision is NOT cached or persisted,
 *               so the next `report_issue` invocation re-prompts.
 *
 * Persistence is the tool's job (so subagent invocations can persist into the
 * disk-backed `Settings` instance the host registered alongside the handler),
 * not the handler's. Implementations live in hosts that have UI affordances —
 * today only `InteractiveMode`. When no handler is registered (CLI subcommands,
 * tests, non-interactive runs) consent defaults to `false` — the explicit
 * "don't collect by default" stance.
 */
export type AutoQaConsentHandler = () => Promise<boolean | null>;

let consentHandler: AutoQaConsentHandler | null = null;
/**
 * Persistent settings instance supplied by the consent-handler registrant.
 * Subagents have in-memory `Settings` snapshots that don't write to disk;
 * we persist the decision through this disk-backed reference so a grant
 * survives across runs even when triggered from a subagent device write.
 */
let persistentConsentSettings: Settings | null = null;
/**
 * Process-global cache of the resolved consent decision. Survives across
 * subagent boundaries (subagents share this module instance), so a grant in
 * the parent applies immediately to children — including children that spawned
 * BEFORE the grant and would otherwise see a stale snapshot of
 * `dev.autoqaConsent` in their isolated `Settings`.
 *
 * `null` = never asked, never cached.
 */
let cachedConsent: boolean | null = null;
/**
 * Single-flight in-flight consent request. While the dialog is open, every
 * concurrent `report_issue` call (main + every subagent) awaits this promise
 * instead of stacking duplicate popups.
 */
let consentInFlight: Promise<boolean> | null = null;

/**
 * Register the consent handler and the persistent {@link Settings} instance
 * the decision should be written to. Passing `null` clears the handler
 * (e.g. on `InteractiveMode` teardown). Re-registration is authoritative.
 */
export function setAutoQaConsentHandler(
	handler: AutoQaConsentHandler | null,
	persistentSettings: Settings | null = null,
): void {
	consentHandler = handler;
	persistentConsentSettings = persistentSettings;
}

/** Test-only: clear consent cache + handler. Never call from production code. */
export function __resetAutoQaConsentForTests(): void {
	consentHandler = null;
	persistentConsentSettings = null;
	cachedConsent = null;
	consentInFlight = null;
}

function readPersistedConsent(settings: Settings | undefined): boolean | null {
	if (!settings) return null;
	const stored = settings.get("dev.autoqaConsent");
	if (stored === "granted") return true;
	if (stored === "denied") return false;
	return null;
}

function persistConsent(localSettings: Settings | undefined, granted: boolean): void {
	const value = granted ? "granted" : "denied";
	try {
		localSettings?.set("dev.autoqaConsent", value);
	} catch (error) {
		logger.warn("Failed to persist auto-QA consent to local settings snapshot", { error: String(error) });
	}
	if (persistentConsentSettings && persistentConsentSettings !== localSettings) {
		try {
			persistentConsentSettings.set("dev.autoqaConsent", value);
		} catch (error) {
			logger.warn("Failed to persist auto-QA consent to persistent settings", { error: String(error) });
		}
	}
}

/**
 * Resolve the user's consent for Auto-QA grievances.
 *
 * Priority:
 * 1. module cache (`cachedConsent`) — process-global, survives subagent boundaries
 * 2. persisted setting on the caller's `Settings`
 * 3. persisted setting on the registered persistent settings instance
 * 4. registered UI handler (single-flight)
 * 5. default `false` (no handler / non-interactive)
 */
export async function resolveAutoQaConsent(settings: Settings | undefined): Promise<boolean> {
	if (cachedConsent !== null) return cachedConsent;
	const localPersisted = readPersistedConsent(settings);
	if (localPersisted !== null) {
		cachedConsent = localPersisted;
		return localPersisted;
	}
	const globalPersisted =
		persistentConsentSettings && persistentConsentSettings !== settings
			? readPersistedConsent(persistentConsentSettings)
			: null;
	if (globalPersisted !== null) {
		cachedConsent = globalPersisted;
		return globalPersisted;
	}
	if (!consentHandler) return false;
	if (consentInFlight) return consentInFlight;
	consentInFlight = (async () => {
		try {
			const result = await consentHandler!();
			if (result === null) return false;
			cachedConsent = result;
			persistConsent(settings, result);
			return result;
		} catch {
			// Transient failure (e.g. dialog crashed) — don't cache; allow re-prompt.
			return false;
		} finally {
			consentInFlight = null;
		}
	})();
	return consentInFlight;
}

let cachedDb: Database | null = null;

/**
 * Open (or return the cached handle for) the auto-QA SQLite database at
 * `~/.omp/agent/autoqa.db`, creating the schema lazily. Returns `null` when
 * the agent data dir cannot be resolved.
 */
export function openAutoQaDb(): Database | null {
	if (cachedDb) return cachedDb;
	const dir = getAutoQaDbDir();
	if (!dir) return null;
	try {
		const db = new Database(`${dir}/autoqa.db`, { create: true });
		db.exec(`
			CREATE TABLE IF NOT EXISTS grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				pushed INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS grievances_pushed_created_at_idx
			ON grievances (pushed, created_at, id);
		`);
		cachedDb = db;
		return db;
	} catch (error) {
		logger.warn("Failed to open auto-QA database", { error: String(error) });
		return null;
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Backend push
// ───────────────────────────────────────────────────────────────────────────

export interface FlushResult {
	pushed: number;
	ok: boolean;
	skipped?: boolean;
}

/**
 * Optional per-flush controls. Used by `omp grievances push` to surface
 * progress to a TTY and to skip the user-facing consent gate (manual
 * pushes are the user's explicit intent, not a side effect of a device write).
 */
export interface FlushOptions {
	/**
	 * Skip the `dev.autoqaConsent === "granted"` gate in
	 * {@link resolvePushConfig}. Endpoint configuration is still required.
	 * Reserved for explicit user-driven pushes (CLI `grievances push`,
	 * future debug recipes); never set from the device's auto-flush path.
	 */
	bypassConsent?: boolean;
	/**
	 * Fetch implementation for the push POST. Defaults to global fetch.
	 */
	fetch?: FetchImpl;
	/**
	 * Fires once at the start of the loop with the snapshot count of
	 * unpushed rows. Subsequent inserts won't be reflected (the count is
	 * a planning hint for progress reporters, not a live total).
	 */
	onStart?: (totalUnpushed: number) => void;
	/**
	 * Fires after every successfully shipped batch with the running pushed
	 * count. Reporters compare against the `totalUnpushed` they saw in
	 * `onStart` to advance their bar.
	 */
	onProgress?: (pushedSoFar: number) => void;
}

interface PushConfig {
	endpoint: string;
	token: string | undefined;
}

const FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_COOLDOWN_MS = 30_000;
/**
 * Per-request batch size. The worker loops until no unpushed rows remain,
 * shipping `FLUSH_BATCH_SIZE` rows per POST. Tunes the trade-off between
 * request count and request size — 50 keeps each payload well under the
 * default `maxBody` limit on the autoqa collector while letting a
 * realistic backlog (a few hundred legacy rows on first flush after the
 * consent grant) drain in single-digit requests.
 */
const FLUSH_BATCH_SIZE = 50;

let inFlightFlush: Promise<FlushResult> | null = null;
let lastFailureAt = 0;

/** Test-only: clear single-flight + cooldown state. Never call from production code. */
export function __resetAutoQaFlushStateForTests(): void {
	inFlightFlush = null;
	lastFailureAt = 0;
}

function envOverrideString(name: string): string | undefined {
	const value = $env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePushConfig(settings: Settings | undefined, bypassConsent: boolean): PushConfig | null {
	if (!isAutoQaEnabled(settings)) return null;

	// Consent IS the push opt-in for the auto-flush path. `bypassConsent`
	// covers explicit user-driven pushes (`omp grievances push`) where the
	// user clearly intends to ship regardless of dialog state. The
	// `PI_AUTO_QA_PUSH` env flag stays as a CI/headless override too.
	if (!bypassConsent) {
		const consented = settings?.get("dev.autoqaConsent") === "granted";
		if (!consented && !$flag("PI_AUTO_QA_PUSH")) return null;
	}

	const endpoint = envOverrideString("PI_AUTO_QA_PUSH_URL") ?? settings?.get("dev.autoqaPush.endpoint");
	if (!endpoint || endpoint.trim().length === 0) return null;

	const token = envOverrideString("PI_AUTO_QA_PUSH_TOKEN") ?? settings?.get("dev.autoqaPush.token");
	return { endpoint: endpoint.trim(), token: token && token.length > 0 ? token : undefined };
}

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
}

async function performFlush(db: Database, config: PushConfig, options: FlushOptions = {}): Promise<FlushResult> {
	const selectStmt = db.prepare(
		"SELECT id, model, version, tool, report FROM grievances WHERE pushed = 0 ORDER BY id ASC LIMIT ?",
	);
	// Planning snapshot — fires once so progress reporters can size their bar.
	// Mid-flight inserts are NOT folded in (the worker drains them too, but
	// the progress bar treats the initial backlog as the denominator).
	if (options.onStart) {
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM grievances WHERE pushed = 0").get() as { n: number };
		options.onStart(totalRow.n);
	}
	const fetchImpl = options.fetch ?? fetch;
	let totalPushed = 0;
	for (;;) {
		const rows = selectStmt.all(FLUSH_BATCH_SIZE) as GrievanceRow[];
		if (rows.length === 0) return { pushed: totalPushed, ok: true };

		const body = JSON.stringify({
			agent: { name: "omp", version: VERSION },
			installId: getInstallId(),
			// Coarse host fingerprint for triage — `darwin`/`linux`/`win32` +
			// `arm64`/`x64`. Useful for "is this bug arch-specific?" without
			// leaking the user's machine name.
			platform: process.platform,
			arch: process.arch,
			entries: rows,
		});
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (config.token) headers.authorization = `Bearer ${config.token}`;

		let response: Response;
		try {
			response = await fetchImpl(config.endpoint, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
			});
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				error: String(error),
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}

		if (!response.ok) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				status: response.status,
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}

		const ids = rows.map(r => r.id);
		const placeholders = ids.map(() => "?").join(",");
		db.prepare(`UPDATE grievances SET pushed = 1 WHERE id IN (${placeholders})`).run(...ids);
		totalPushed += rows.length;
		options.onProgress?.(totalPushed);
	}
}

/**
 * Flush queued grievances to the configured backend.
 */
export async function flushGrievances(
	db?: Database,
	settings?: Settings,
	options: FlushOptions = {},
): Promise<FlushResult> {
	const config = resolvePushConfig(settings, options.bypassConsent === true);
	if (!config) return { pushed: 0, ok: false, skipped: true };

	const bypass = options.bypassConsent === true;
	if (!bypass && inFlightFlush) return inFlightFlush;

	if (!bypass && lastFailureAt > 0 && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
		return { pushed: 0, ok: false, skipped: true };
	}

	const handle = db ?? openAutoQaDb();
	if (!handle) return { pushed: 0, ok: false, skipped: true };

	const promise = (async () => {
		try {
			return await performFlush(handle, config, options);
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", { endpoint: config.endpoint, error: String(error) });
			return { pushed: 0, ok: false };
		}
	})();

	if (!bypass) inFlightFlush = promise;
	try {
		return await promise;
	} finally {
		if (!bypass) inFlightFlush = null;
	}
}

/** Record a grievance row and trigger the background consent/flush pipeline. */
async function recordToolIssue(session: ToolSession, tool: string, report: string): Promise<void> {
	const canonicalTool = tool.startsWith("proxy_") ? tool.slice("proxy_".length) : tool;
	const db = openAutoQaDb();
	if (!db) return;
	db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)").run(
		session.getActiveModelString?.() ?? "unknown",
		VERSION,
		canonicalTool,
		report,
	);
	void (async () => {
		try {
			await resolveAutoQaConsent(session.settings);
			await flushGrievances(db, session.settings);
		} catch (error) {
			logger.debug("autoqa post-insert pipeline failed", { error: String(error) });
		}
	})();
}

/**
 * Execute `write xd://report_issue`. `text` must be either:
 * - `<tool>: <concise description>` on one line, or
 * - tool name on the first line with the report body below.
 */
export async function dispatchReportIssueDevice(
	session: ToolSession,
	text: string,
): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
	try {
		if (isAutoQaEnabled(session.settings)) {
			const { tool, report } = parseReportIssueBody(text);
			await recordToolIssue(session, tool, report);
		}
	} catch (error) {
		if (error instanceof ToolError) throw error;
		logger.error("Failed to record tool issue", { error });
	}
	return {
		result: { content: [{ type: "text", text: "Noted, thanks!" }] },
		xdev: { tool: REPORT_ISSUE_DEVICE_NAME, mode: "execute", args: { report: text.trim() } },
	};
}
