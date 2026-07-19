import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSessionDoctorCli } from "../src/commands/session-doctor-cli.ts";
import { inspectRunJournal } from "../src/core/run-journal.ts";
import { RunJournalStore } from "../src/core/run-journal-store.ts";
import { inspectSessionIntegrity } from "../src/core/session-integrity.ts";

function assistant(toolCallId: string) {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "echo", arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(toolCallId: string) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "echo",
		content: [{ type: "text", text: "orphan" }],
		isError: false,
		timestamp: 1,
	};
}

describe("omk session doctor CLI", () => {
	let root: string;
	let cwd: string;
	let sessionDir: string;
	let sessionPath: string;
	let lines: string[];

	beforeEach(() => {
		root = join(tmpdir(), `omk-session-doctor-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(root, "workspace");
		sessionDir = join(root, "sessions");
		sessionPath = join(sessionDir, "session.jsonl");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		lines = [];
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function records(message: unknown) {
		return [
			{ type: "session", version: 3, id: "session-doctor", timestamp: "2026-07-17T00:00:00.000Z", cwd },
			{
				type: "message",
				id: "u",
				parentId: null,
				timestamp: "2026-07-17T00:00:01.000Z",
				message: { role: "user", content: "run", timestamp: 1 },
			},
			{
				type: "message",
				id: "a",
				parentId: "u",
				timestamp: "2026-07-17T00:00:02.000Z",
				message,
			},
			{
				type: "model_change",
				id: "m",
				parentId: "a",
				timestamp: "2026-07-17T00:00:03.000Z",
				provider: "openai",
				modelId: "mock",
			},
		];
	}

	function writeSession(sessionRecords: readonly unknown[], fragment = "") {
		writeFileSync(sessionPath, `${sessionRecords.map((record) => JSON.stringify(record)).join("\n")}\n${fragment}`);
	}

	const invoke = (args: string[], beforeExecute?: () => void) =>
		runSessionDoctorCli(args, {
			cwd,
			sessionDir,
			now: () => new Date("2026-07-17T01:00:00.000Z"),
			writeLine: (line) => lines.push(line),
			beforeExecute,
		});

	it("is a pre-parse command and leaves unrelated argv untouched", async () => {
		expect(await invoke(["--help"])).toEqual({ handled: false, exitCode: 0 });
	});

	it("inspects all sessions when --session is omitted", async () => {
		const done = {
			...assistant("unused"),
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
		};
		writeSession(records(done));
		writeFileSync(join(sessionDir, "second.jsonl"), readFileSync(sessionPath));

		const outcome = await invoke(["session", "doctor"]);
		const batch = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;

		expect(outcome).toEqual({ handled: true, exitCode: 0 });
		expect(batch).toMatchObject({ scope: "all", status: "healthy", sessionCount: 2, exitCode: 0 });
		expect(batch.sessions).toHaveLength(2);
	});

	it("dry-runs missing-only plus trailing-fragment repair without writing", async () => {
		const fragment = '{"partial":';
		writeSession(records(assistant("call-1")), fragment);
		const before = readFileSync(sessionPath);

		const outcome = await invoke(["session", "doctor", "--session", sessionPath, "--repair", "--dry-run"]);

		expect(outcome.handled).toBe(true);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.result?.mode).toBe("repair_dry_run");
		expect(outcome.result?.actions.map((action) => action.kind)).toEqual([
			"quarantine_session_trailing_fragment",
			"append_synthetic_tool_result",
		]);
		expect(readFileSync(sessionPath)).toEqual(before);
		expect(existsSync(`${sessionPath}.quarantine-${outcome.result?.repairId}`)).toBe(false);
	});

	it("repairs allowed missing-only/trailing damage, quarantines exact bytes, and re-inspects clean", async () => {
		const fragment = Buffer.from('{"partial":', "utf8");
		writeSession(records(assistant("call-1")), fragment.toString());

		const outcome = await invoke(["session", "doctor", "--session", sessionPath, "--repair"]);

		expect(outcome.exitCode).toBe(0);
		expect(outcome.result?.appliedActions).toBe(2);
		expect(inspectSessionIntegrity(readFileSync(sessionPath)).ok).toBe(true);
		const quarantinePath = `${sessionPath}.quarantine-${outcome.result?.repairId}`;
		expect(readFileSync(quarantinePath)).toEqual(fragment);
		const repaired = readFileSync(sessionPath, "utf8");
		expect(repaired).toContain('"schema":"tool-result/v2"');
	});

	it("refuses ambiguous orphan transcript damage and writes nothing", async () => {
		writeSession(records(toolResult("orphan-call")));
		const before = readFileSync(sessionPath);

		const outcome = await invoke(["session", "doctor", "--session", sessionPath, "--repair"]);

		expect(outcome.exitCode).toBe(2);
		expect(outcome.result?.status).toBe("refused");
		expect(outcome.result?.actions).toEqual([]);
		expect(readFileSync(sessionPath)).toEqual(before);
	});

	it("quarantines a journal fragment and recovers an unclosed run, while refusing hash damage", async () => {
		const done = {
			...assistant("unused"),
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
		};
		writeSession(records(done));
		const journalPath = `${sessionPath}.runjournal`;
		const journal = RunJournalStore.open({
			journalPath,
			sessionId: "session-doctor",
			now: () => "2026-07-17T00:10:00.000Z",
		});
		journal.start({ runId: "run-crashed", sessionRevision: 4, timestamp: "2026-07-17T00:10:00.000Z" });
		const fragment = Buffer.from('{"partial":', "utf8");
		appendFileSync(journalPath, fragment);
		const before = readFileSync(journalPath);

		const dry = await invoke(["session", "doctor", "--session", sessionPath, "--repair", "--dry-run"]);
		expect(dry.result?.actions.map((action) => action.kind)).toContain("recover_run");
		expect(readFileSync(journalPath)).toEqual(before);

		const repaired = await invoke(["session", "doctor", "--session", sessionPath, "--repair"]);
		expect(repaired.exitCode).toBe(0);
		expect(inspectRunJournal(readFileSync(journalPath), RunJournalStore.sha256).ok).toBe(true);
		expect(readFileSync(`${journalPath}.quarantine-${repaired.result?.repairId}`)).toEqual(fragment);

		const damaged = readFileSync(journalPath, "utf8").replace(/"hash":"[0-9a-f]{64}"/, `"hash":"${"f".repeat(64)}"`);
		writeFileSync(journalPath, damaged);
		const refused = await invoke(["session", "doctor", "--session", sessionPath, "--repair"]);
		expect(refused.exitCode).toBe(2);
		expect(readFileSync(journalPath, "utf8")).toBe(damaged);
	});

	it("allows a stale compaction transaction to be abandoned only through the planned repair", async () => {
		const done = {
			...assistant("unused"),
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
		};
		writeSession(records(done));
		const digest = "a".repeat(64);
		const source = {
			sessionId: "session-doctor",
			entryIds: ["u", "a", "m"],
			firstEntryId: "u",
			lastEntryId: "m",
			sourceSha256: digest,
			activeLeafId: "m",
			messageCount: 2,
		};
		const revision = {
			schemaVersion: 1,
			sessionId: "session-doctor",
			completeBytes: 10,
			recordCount: 4,
			leafId: "m",
			lastEntryId: "m",
			completePrefixSha256: digest,
		};
		const sidecar = `${sessionPath}.compaction-transaction.json`;
		writeFileSync(
			sidecar,
			JSON.stringify({
				transaction: {
					schemaVersion: 1,
					transactionId: "txn-stale",
					baseRevision: { ...revision, recordCount: 3 },
					source,
					createdAt: "2026-07-17T00:30:00.000Z",
					model: { provider: "openai", id: "mock" },
					preserved: {
						latestIntent: "finish",
						openTasks: [],
						laneIds: [],
						acceptancePredicateIds: [],
						evidenceReceiptIds: [],
						blockerReasons: [],
						repairEventIds: [],
						branch: null,
						worktree: null,
						modelHistory: [],
						nextAction: "continue",
					},
				},
				currentRevision: revision,
				currentSource: source,
				barrier: {
					status: "ready",
					reason: "closed_active_branch",
					pendingToolCallIds: [],
					missingToolCallIds: [],
				},
				priorCommittedSourceDigests: [],
			}),
		);

		const dry = await invoke(["session", "doctor", "--session", sessionPath, "--repair", "--dry-run"]);
		expect(
			dry.result?.actions.map((action) => action.kind),
			JSON.stringify(dry.result),
		).toContain("abandon_stale_compaction");
		expect(existsSync(sidecar)).toBe(true);

		const repaired = await invoke(["session", "doctor", "--session", sessionPath, "--repair"]);
		expect(repaired.exitCode).toBe(0);
		expect(existsSync(sidecar)).toBe(false);
		expect(existsSync(`${sidecar}.abandoned-${repaired.result?.repairId}`)).toBe(true);
	});

	it("refuses CAS when session bytes change between planning and execution", async () => {
		writeSession(records(assistant("call-1")));
		const plannedSha = createHash("sha256").update(readFileSync(sessionPath)).digest("hex");

		const outcome = await invoke(["session", "doctor", "--session", sessionPath, "--repair"], () => {
			writeFileSync(sessionPath, `${readFileSync(sessionPath, "utf8")} `);
		});

		expect(outcome.exitCode).toBe(2);
		expect(outcome.result?.status).toBe("refused");
		expect(outcome.result?.preconditionSha256).toBe(plannedSha);
		expect(outcome.result?.errorCode).toBe("precondition_changed");
	});
});
