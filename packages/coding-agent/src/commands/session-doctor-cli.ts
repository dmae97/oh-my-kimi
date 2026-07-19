import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	type Stats,
	statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { atomicRewriteFileSync } from "../core/atomic-session-file.ts";
import { type DecideCompactionCommitInput, validateCompactionEnvelope } from "../core/compaction/transaction.ts";
import {
	GENESIS_HASH,
	inspectRunJournal,
	RUN_JOURNAL_SCHEMA_VERSION,
	type RunJournalReport,
	type RunJournalTerminalRecord,
	serializeRunJournalLine,
	serializeRunJournalMaterial,
} from "../core/run-journal.ts";
import { RunJournalStore, writeQuarantineBytesDurably } from "../core/run-journal-store.ts";
import {
	planSessionDoctor,
	type SessionDoctorAction,
	type SessionDoctorMode,
	type SessionDoctorNormalizedCheck,
	type SessionDoctorPlan,
} from "../core/session-doctor-plan.ts";
import { inspectSessionIntegrity, type SessionIntegrityReport } from "../core/session-integrity.ts";
import { SessionManager } from "../core/session-manager.ts";
import {
	decideSessionPathAccess,
	type SessionPathAccessInput,
	type SessionPathChainEntry,
	type SessionPathStat,
} from "../core/session-path-policy.ts";
import { classifySessionTermination } from "../core/session-termination.ts";
import { validateEvidenceReceipt } from "../guardrails/evidence-receipt.ts";
import { ReplayLedgerManager } from "../guardrails/evidence-system.ts";
import { resolvePath } from "../utils/paths.ts";

const USAGE = "Usage: omk session doctor [--session <path|id>] [--repair [--dry-run]]";

export interface SessionDoctorCliOverrides {
	readonly cwd?: string;
	readonly sessionDir?: string;
	readonly now?: () => Date;
	readonly writeLine?: (line: string) => void;
	/** Test seam invoked after planning and before the repair CAS lock. */
	readonly beforeExecute?: () => void;
}

export interface SessionDoctorCliResult {
	readonly schemaVersion: 1;
	readonly command: "session_doctor";
	readonly mode: SessionDoctorMode;
	readonly sessionId: string;
	readonly sessionPath: string;
	readonly repairId: string;
	readonly status: "healthy" | "issues" | "refused";
	readonly exitCode: 0 | 1 | 2;
	readonly findings: SessionDoctorPlan["findings"];
	readonly actions: SessionDoctorPlan["actions"];
	readonly normalizedChecks: readonly SessionDoctorNormalizedCheck[];
	readonly appliedActions: number;
	readonly preconditionSha256: string;
	readonly errorCode?: "precondition_changed" | "repair_failed";
}

export interface SessionDoctorCliBatchResult {
	readonly schemaVersion: 1;
	readonly command: "session_doctor";
	readonly mode: SessionDoctorMode;
	readonly scope: "all";
	readonly status: "healthy" | "issues" | "refused";
	readonly exitCode: 0 | 1 | 2;
	readonly sessionCount: number;
	readonly appliedActions: number;
	readonly sessions: readonly SessionDoctorCliResult[];
}

export interface SessionDoctorCliOutcome {
	readonly handled: boolean;
	readonly exitCode: number;
	readonly result?: SessionDoctorCliResult;
}

type ParseOutcome =
	| { readonly kind: "absent" }
	| { readonly kind: "help" }
	| { readonly kind: "error"; readonly message: string }
	| {
			readonly kind: "ok";
			readonly session?: string;
			readonly mode: SessionDoctorMode;
	  };

function parseArgs(args: readonly string[]): ParseOutcome {
	if (args[0] !== "session" || args[1] !== "doctor") return { kind: "absent" };
	let session: string | undefined;
	let repair = false;
	let dryRun = false;
	for (let index = 2; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") return { kind: "help" };
		if (arg === "--repair") {
			repair = true;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--session") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) return { kind: "error", message: "--session requires a value" };
			session = value;
			index += 1;
			continue;
		}
		return { kind: "error", message: "unexpected session doctor argument" };
	}
	if (dryRun && !repair) return { kind: "error", message: "--dry-run requires --repair" };
	return { kind: "ok", session, mode: repair ? (dryRun ? "repair_dry_run" : "repair") : "inspect" };
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function resolveSession(
	argument: string | undefined,
	cwd: string,
	sessionDir: string | undefined,
): Promise<string | null> {
	if (argument && (argument.includes("/") || argument.includes("\\") || argument.endsWith(".jsonl"))) {
		const path = resolvePath(argument, cwd);
		return existsSync(path) ? path : null;
	}
	const local = await SessionManager.list(cwd, sessionDir);
	if (argument) {
		const localMatches = local.filter((session) => session.id === argument || session.id.startsWith(argument));
		if (localMatches.length === 1) return localMatches[0].path;
		const all = await SessionManager.listAll(sessionDir);
		const globalMatches = all.filter((session) => session.id === argument || session.id.startsWith(argument));
		return globalMatches.length === 1 ? globalMatches[0].path : null;
	}
	return local[0]?.path ?? null;
}

function pathStat(stat: Stats): SessionPathStat {
	return {
		dev: String(stat.dev),
		ino: String(stat.ino),
		nlink: stat.nlink,
		size: stat.size,
		mtime: Math.max(0, Math.trunc(stat.mtimeMs)),
		regular: stat.isFile(),
		owner: String(stat.uid),
	};
}

function pathObservation(target: string): Omit<SessionPathAccessInput, "intent"> {
	const root = dirname(target);
	const rootReal = realpathSync(root);
	const targetReal = realpathSync(target);
	const rootLstat = lstatSync(root);
	const targetLstat = lstatSync(target);
	const chain: SessionPathChainEntry[] = [
		{ lexical: root, realpath: rootReal, linkKind: rootLstat.isSymbolicLink() ? "symlink" : "none" },
		{ lexical: target, realpath: targetReal, linkKind: targetLstat.isSymbolicLink() ? "symlink" : "none" },
	];
	const before = statSync(target);
	const fd = openSync(target, "r");
	let opened: Stats;
	try {
		opened = fstatSync(fd);
	} finally {
		closeSync(fd);
	}
	const after = statSync(target);
	const owner = typeof process.getuid === "function" ? process.getuid() : before.uid;
	const lockExists = existsSync(`${target}.lock`);
	return {
		platform: process.platform === "win32" ? "win32" : "posix",
		root,
		target,
		identity: { owner: String(owner) },
		evidence: {
			schemaVersion: 1,
			platform: process.platform === "win32" ? "win32" : "posix",
			trustedRootLexical: root,
			trustedRootRealpath: rootReal,
			target: { lexical: target, realpath: targetReal },
			chain,
			statBefore: pathStat(before),
			statAfter: pathStat(after),
			opened: { dev: String(opened.dev), ino: String(opened.ino) },
		},
		lock: lockExists
			? { state: "unknown", sameHost: false, pidDefinitelyAbsent: false, holderPid: null }
			: { state: "absent", sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
	};
}

function normalizedChecks(
	report: SessionIntegrityReport,
	sessionPath: string,
): readonly SessionDoctorNormalizedCheck[] {
	const checks: SessionDoctorNormalizedCheck[] = [];
	const compactions = report.entries.filter((entry) => entry.type === "compaction");
	let compactionStatus: SessionDoctorNormalizedCheck["status"] = "ok";
	for (const entry of compactions) {
		const details = entry.details;
		if (typeof details !== "object" || details === null || !("compactionEnvelope" in details)) {
			compactionStatus = "missing";
			break;
		}
		try {
			const envelope = validateCompactionEnvelope((details as { compactionEnvelope: unknown }).compactionEnvelope);
			const summarySha256 = createHash("sha256").update(entry.summary, "utf8").digest("hex");
			if (
				envelope.source.sessionId !== report.header?.id ||
				envelope.summary !== entry.summary ||
				envelope.summarySha256 !== summarySha256 ||
				envelope.source.activeLeafId !== entry.parentId
			) {
				compactionStatus = "invalid";
				break;
			}
		} catch {
			compactionStatus = "invalid";
			break;
		}
	}
	checks.push({ artifact: "compaction_envelope", id: "compaction", status: compactionStatus });

	const replayPath = `${sessionPath}.replay.jsonl`;
	let replayStatus: SessionDoctorNormalizedCheck["status"] = "ok";
	if (existsSync(replayPath)) {
		try {
			const ledger = new ReplayLedgerManager(report.header?.id ?? "unknown", replayPath);
			if (ledger.getEvents().some((event) => event.goalId !== report.header?.id)) replayStatus = "invalid";
		} catch {
			replayStatus = "invalid";
		}
	}
	checks.push({ artifact: "evidence_link", id: "replay-ledger", status: replayStatus });

	let receiptStatus: SessionDoctorNormalizedCheck["status"] = "ok";
	for (const entry of report.entries) {
		if (entry.type !== "custom" || entry.customType !== "evidence_receipt") continue;
		try {
			validateEvidenceReceipt(entry.data);
		} catch {
			receiptStatus = "invalid";
			break;
		}
	}
	checks.push({ artifact: "evidence_link", id: "evidence-receipts", status: receiptStatus });

	let workspaceStatus: SessionDoctorNormalizedCheck["status"] = "invalid";
	try {
		workspaceStatus = report.header && statSync(report.header.cwd).isDirectory() ? "ok" : "missing";
	} catch {
		workspaceStatus = "missing";
	}
	checks.push({ artifact: "workspace", id: "workspace", status: workspaceStatus });

	const hasProviderModel = report.entries.some((entry) => entry.type === "model_change");
	checks.push({
		artifact: "provider_model",
		id: "active-provider-model",
		status: hasProviderModel ? "ok" : "missing",
	});
	return Object.freeze(checks);
}

function makeRecoveryRecord(
	report: RunJournalReport,
	sessionId: string,
	timestamp: string,
): RunJournalTerminalRecord | undefined {
	if (report.openRunId === null) return undefined;
	const last = report.records.at(-1);
	const termination = classifySessionTermination({
		sessionId,
		runId: report.openRunId,
		timestamp,
		source: "inferred_on_resume",
		message: "Previous process exited without closing the run; recovered by session doctor.",
		cause: { area: "process", code: "crash" },
		sideEffects: "possible",
	});
	const material: Omit<RunJournalTerminalRecord, "hash"> = {
		schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
		seq: (last?.seq ?? -1) + 1,
		event: "run_recovered",
		runId: report.openRunId,
		sessionId,
		sessionRevision: last?.sessionRevision ?? 0,
		timestamp,
		prevHash: last?.hash ?? GENESIS_HASH,
		termination,
	};
	return Object.freeze({
		...material,
		hash: RunJournalStore.sha256(new TextEncoder().encode(serializeRunJournalMaterial(material))),
	});
}

function hardSessionDamage(report: SessionIntegrityReport): boolean {
	return report.findings.some(
		(finding) => finding.reason !== "trailing_fragment" && finding.reason !== "transcript_missing_result",
	);
}

function hardJournalDamage(report: RunJournalReport | null): boolean {
	return (
		report?.findings.some((finding) => finding.code !== "trailing_fragment" && finding.code !== "run_unclosed") ??
		false
	);
}

function parsePrefixEntries(bytes: Uint8Array): Array<Record<string, unknown>> {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function applySessionActions(
	sessionPath: string,
	repairId: string,
	report: SessionIntegrityReport,
	actions: readonly SessionDoctorAction[],
	preconditionSha256: string,
	now: Date,
): number {
	const sessionActions = actions.filter(
		(action) =>
			action.kind === "quarantine_session_trailing_fragment" || action.kind === "append_synthetic_tool_result",
	);
	if (sessionActions.length === 0) return 0;
	const release = lockfile.lockSync(sessionPath, { realpath: false });
	try {
		const current = new Uint8Array(readFileSync(sessionPath));
		if (sha256(current) !== preconditionSha256) throw new Error("precondition_changed");
		const prefix = current.subarray(0, report.completePrefix.byteCount);
		if (report.trailingFragment) {
			writeQuarantineBytesDurably(`${sessionPath}.quarantine-${repairId}`, current.subarray(prefix.byteLength));
		}
		const records = parsePrefixEntries(prefix);
		let parentId = report.activeLeafId;
		for (const action of sessionActions) {
			if (action.kind !== "append_synthetic_tool_result") continue;
			let id = `doctor-${repairId.slice(0, 20)}-${action.sequence}`;
			while (records.some((record) => record.id === id)) id = `${id}-x`;
			records.push({
				type: "message",
				id,
				parentId,
				timestamp: new Date(now.getTime() + action.sequence).toISOString(),
				message: action.message,
			});
			parentId = id;
		}
		atomicRewriteFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		return sessionActions.length;
	} finally {
		release();
	}
}

function applyJournalActions(
	journalPath: string,
	repairId: string,
	report: RunJournalReport,
	actions: readonly SessionDoctorAction[],
	preconditionSha256: string,
): number {
	const journalActions = actions.filter(
		(action) => action.kind === "quarantine_journal_trailing_fragment" || action.kind === "recover_run",
	);
	if (journalActions.length === 0) return 0;
	const release = lockfile.lockSync(journalPath, { realpath: false });
	try {
		const current = new Uint8Array(readFileSync(journalPath));
		if (sha256(current) !== preconditionSha256) throw new Error("precondition_changed");
		const prefix = current.subarray(0, report.completePrefix.byteCount);
		if (report.trailingByteCount > 0) {
			writeQuarantineBytesDurably(`${journalPath}.quarantine-${repairId}`, current.subarray(prefix.byteLength));
		}
		const recovery = journalActions.find(
			(action): action is Extract<SessionDoctorAction, { kind: "recover_run" }> => action.kind === "recover_run",
		);
		const suffix = recovery
			? new TextEncoder().encode(`${serializeRunJournalLine(recovery.terminalRecord)}\n`)
			: null;
		const output = suffix ? Buffer.concat([Buffer.from(prefix), Buffer.from(suffix)]) : prefix;
		atomicRewriteFileSync(journalPath, output);
		return journalActions.length;
	} finally {
		release();
	}
}

function applyCompactionActions(
	sidecarPath: string,
	repairId: string,
	actions: readonly SessionDoctorAction[],
	preconditionSha256: string,
): number {
	const abandon = actions.find((action) => action.kind === "abandon_stale_compaction");
	if (!abandon) return 0;
	const release = lockfile.lockSync(sidecarPath, { realpath: false });
	try {
		if (sha256(readFileSync(sidecarPath)) !== preconditionSha256) throw new Error("precondition_changed");
		renameSync(sidecarPath, `${sidecarPath}.abandoned-${repairId}`);
		if (process.platform !== "win32") {
			const dirFd = openSync(dirname(sidecarPath), "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		}
		return 1;
	} finally {
		release();
	}
}

function refusedResult(
	base: Omit<SessionDoctorCliResult, "status" | "exitCode" | "appliedActions">,
	errorCode?: SessionDoctorCliResult["errorCode"],
): SessionDoctorCliResult {
	return {
		...base,
		status: "refused",
		exitCode: 2,
		appliedActions: 0,
		...(errorCode ? { errorCode } : {}),
	};
}

export async function runSessionDoctorCli(
	args: readonly string[],
	overrides: SessionDoctorCliOverrides = {},
): Promise<SessionDoctorCliOutcome> {
	const parsed = parseArgs(args);
	if (parsed.kind === "absent") return { handled: false, exitCode: 0 };
	const writeLine = overrides.writeLine ?? ((line: string) => console.log(line));
	if (parsed.kind === "help") {
		writeLine(USAGE);
		return { handled: true, exitCode: 0 };
	}
	if (parsed.kind === "error") {
		writeLine(JSON.stringify({ status: "refused", error: parsed.message, usage: USAGE }));
		return { handled: true, exitCode: 2 };
	}

	const cwd = resolve(overrides.cwd ?? process.cwd());
	if (parsed.session === undefined) {
		const sessions = await SessionManager.listAll(overrides.sessionDir);
		const paths = [...new Set(sessions.map((session) => session.path))];
		const nestedArgs = ["session", "doctor"];
		if (parsed.mode !== "inspect") nestedArgs.push("--repair");
		if (parsed.mode === "repair_dry_run") nestedArgs.push("--dry-run");
		const results: SessionDoctorCliResult[] = [];
		let exitCode: 0 | 1 | 2 = 0;
		for (const path of paths) {
			const outcome = await runSessionDoctorCli([...nestedArgs, "--session", path], {
				...overrides,
				writeLine: () => {},
			});
			exitCode = Math.max(exitCode, outcome.exitCode) as 0 | 1 | 2;
			if (outcome.result) results.push(outcome.result);
		}
		const batch: SessionDoctorCliBatchResult = {
			schemaVersion: 1,
			command: "session_doctor",
			mode: parsed.mode,
			scope: "all",
			status: exitCode === 2 ? "refused" : exitCode === 1 ? "issues" : "healthy",
			exitCode,
			sessionCount: paths.length,
			appliedActions: results.reduce((total, result) => total + result.appliedActions, 0),
			sessions: results,
		};
		writeLine(JSON.stringify(batch, null, 2));
		return { handled: true, exitCode };
	}
	const sessionPath = await resolveSession(parsed.session, cwd, overrides.sessionDir);
	if (!sessionPath) {
		writeLine(JSON.stringify({ status: "refused", error: "session_not_found", usage: USAGE }));
		return { handled: true, exitCode: 2 };
	}
	const now = overrides.now?.() ?? new Date();
	const repairId = randomUUID();
	const sessionBytes = new Uint8Array(readFileSync(sessionPath));
	const preconditionSha256 = sha256(sessionBytes);
	const report = inspectSessionIntegrity(sessionBytes);
	const sessionId = report.header?.id ?? "unknown-session";
	const checks = normalizedChecks(report, sessionPath);
	const compactionPath = `${sessionPath}.compaction-transaction.json`;
	const compactionBytes = existsSync(compactionPath) ? new Uint8Array(readFileSync(compactionPath)) : null;
	let compaction: DecideCompactionCommitInput | undefined;
	let compactionInvalid = false;
	if (compactionBytes) {
		try {
			compaction = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(compactionBytes),
			) as DecideCompactionCommitInput;
		} catch {
			compactionInvalid = true;
		}
	}
	const compactionPathAuthorized =
		compactionBytes === null ||
		decideSessionPathAccess({
			...pathObservation(compactionPath),
			intent: parsed.mode === "inspect" ? "inspect_content" : parsed.mode === "repair" ? "repair" : "repair_dry_run",
		}).status === "authorized";
	const journalPath = `${sessionPath}.runjournal`;
	const journalBytes = existsSync(journalPath) ? new Uint8Array(readFileSync(journalPath)) : null;
	const journalReport = journalBytes ? inspectRunJournal(journalBytes, RunJournalStore.sha256) : null;
	const terminalRecord = journalReport ? makeRecoveryRecord(journalReport, sessionId, now.toISOString()) : undefined;
	const plan = planSessionDoctor({
		mode: parsed.mode,
		sessionId,
		repairId,
		timestamp: now.getTime(),
		report,
		...(compaction ? { compaction } : {}),
		...(journalBytes
			? {
					journal: {
						bytes: journalBytes,
						hashFn: RunJournalStore.sha256,
						...(terminalRecord ? { terminalRecord } : {}),
					},
				}
			: {}),
		paths: {
			session: pathObservation(sessionPath),
			...(journalBytes ? { journal: pathObservation(journalPath) } : {}),
		},
		normalizedChecks: checks,
	});
	const base = {
		schemaVersion: 1 as const,
		command: "session_doctor" as const,
		mode: parsed.mode,
		sessionId,
		sessionPath,
		repairId,
		findings: plan.findings,
		actions: plan.actions,
		normalizedChecks: checks,
		preconditionSha256,
	};

	if (
		hardSessionDamage(report) ||
		hardJournalDamage(journalReport) ||
		compactionInvalid ||
		!compactionPathAuthorized ||
		plan.status === "refused"
	) {
		const result = refusedResult(base);
		writeLine(JSON.stringify(result, null, 2));
		return { handled: true, exitCode: result.exitCode, result };
	}
	if (parsed.mode !== "repair") {
		const result: SessionDoctorCliResult = {
			...base,
			status: plan.status,
			exitCode: plan.exitCode,
			appliedActions: 0,
		};
		writeLine(JSON.stringify(result, null, 2));
		return { handled: true, exitCode: result.exitCode, result };
	}

	overrides.beforeExecute?.();
	let appliedActions = 0;
	try {
		appliedActions += applySessionActions(sessionPath, repairId, report, plan.actions, preconditionSha256, now);
		if (journalBytes && journalReport) {
			appliedActions += applyJournalActions(
				journalPath,
				repairId,
				journalReport,
				plan.actions,
				sha256(journalBytes),
			);
		}
		if (compactionBytes) {
			appliedActions += applyCompactionActions(compactionPath, repairId, plan.actions, sha256(compactionBytes));
		}
	} catch (error) {
		const code =
			error instanceof Error && error.message === "precondition_changed" ? "precondition_changed" : "repair_failed";
		const result = refusedResult(base, code);
		writeLine(JSON.stringify(result, null, 2));
		return { handled: true, exitCode: result.exitCode, result };
	}

	const finalSession = inspectSessionIntegrity(readFileSync(sessionPath));
	const finalJournal = existsSync(journalPath)
		? inspectRunJournal(readFileSync(journalPath), RunJournalStore.sha256)
		: null;
	const healthy = finalSession.ok && (finalJournal?.ok ?? true);
	const result: SessionDoctorCliResult = {
		...base,
		status: healthy ? "healthy" : "issues",
		exitCode: healthy ? 0 : 1,
		appliedActions,
	};
	writeLine(JSON.stringify(result, null, 2));
	return { handled: true, exitCode: result.exitCode, result };
}
