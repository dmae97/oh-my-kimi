import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayLedgerManager } from "../src/guardrails/evidence-system.ts";
import {
	EMPTY_REPLAY_LEDGER_HEAD,
	ReplayLedgerStore,
	replayLedgerHeadsEqual,
} from "../src/guardrails/replay-ledger-store.ts";
import type { ReplayLedgerHead } from "../src/types/evidence.ts";

const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

type InspectedStore = {
	readonly lastSeq: number;
	readonly lastHash: string;
};

function inspectStore(bytes: Buffer): InspectedStore {
	if (bytes.byteLength === 0) return { lastSeq: 0, lastHash: "genesis" };
	const lines = bytes.toString("utf8").trim().split("\n");
	const value: unknown = JSON.parse(lines.at(-1) ?? "null");
	if (
		typeof value !== "object" ||
		value === null ||
		!("seq" in value) ||
		!("hash" in value) ||
		typeof value.seq !== "number" ||
		typeof value.hash !== "string"
	) {
		throw new Error("invalid synthetic store line");
	}
	return { lastSeq: value.seq, lastHash: value.hash };
}

function storeLine(seq: number, hash: string): Buffer {
	return Buffer.from(`${JSON.stringify({ seq, hash })}\n`, "utf8");
}

function lockRecord(pid: number, acquiredAtMs = Date.now()): string {
	let processStartToken: string | null = null;
	if (process.platform === "linux") {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const startTime = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/)[19];
		if (startTime === undefined) throw new Error("invalid process stat fixture");
		processStartToken = `linux:${startTime}`;
	}
	return `${JSON.stringify({ schemaVersion: 2, pid, processStartToken, acquiredAtMs, ownerId: randomUUID() })}\n`;
}

describe("ReplayLedgerManager", () => {
	let root: string;
	let ledgerPath: string;
	let replayPath: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "omk-replay-ledger-"));
		ledgerPath = join(root, "ledger.jsonl");
		replayPath = join(root, "replay.jsonl");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("appends, persists, and reopens chained events", () => {
		const ledger = new ReplayLedgerManager("goal-ledger", ledgerPath);
		ledger.append({ type: "session_start", goalId: "goal-ledger", payload: { message: "hello" } });
		ledger.append({ type: "tool_call", goalId: "goal-ledger", laneId: "lane-1", payload: { tool: "read" } });
		ledger.persist();

		const events = ledger.getEvents();
		expect(events.map((event) => event.seq)).toEqual([1, 2]);
		expect(events[0].prevHash).toBe("genesis");
		expect(events[1].prevHash).toBe(events[0].eventHash);
		expect(new ReplayLedgerManager("goal-ledger", ledgerPath).getEvents()).toHaveLength(2);
	});

	it("fails closed when a persisted payload is tampered", () => {
		const ledger = new ReplayLedgerManager("goal-tamper", ledgerPath);
		ledger.append({ type: "tool_call", goalId: "goal-tamper", payload: { tool: "read" } });
		ledger.append({ type: "tool_call", goalId: "goal-tamper", payload: { tool: "write" } });
		const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
		const forged: unknown = JSON.parse(lines[1]);
		if (typeof forged !== "object" || forged === null || !("payload" in forged)) throw new Error("bad fixture");
		forged.payload = { tool: "rm" };
		lines[1] = JSON.stringify(forged);
		writeFileSync(ledgerPath, `${lines.join("\n")}\n`, "utf8");

		expect(() => new ReplayLedgerManager("goal-tamper", ledgerPath)).toThrow(/tampered/);
	});

	it("preserves truncation and same-size file-identity ABA rejection", () => {
		const ledger = new ReplayLedgerManager("goal-order", ledgerPath);
		ledger.append({ type: "tool_call", goalId: "goal-order", payload: { n: 1 } });
		ledger.append({ type: "tool_call", goalId: "goal-order", payload: { n: 2 } });
		const committed = ledger.getCommittedHead();
		const bytes = readFileSync(ledgerPath, "utf8");
		writeFileSync(ledgerPath, `${bytes.trim().split("\n")[0]}\n`, "utf8");
		expect(() => ledger.getVerifiedSnapshot(committed)).toThrow(/head|size|suffix|CAS/i);

		writeFileSync(ledgerPath, bytes, "utf8");
		const replacement = `${ledgerPath}.replacement`;
		writeFileSync(replacement, bytes, "utf8");
		renameSync(replacement, ledgerPath);
		expect(() => ledger.getVerifiedSnapshot(committed)).toThrow(/identity|CAS/i);
	});

	it("serializes multi-manager appends with external expected-head CAS", () => {
		const first = new ReplayLedgerManager("goal-cas", ledgerPath);
		const stale = new ReplayLedgerManager("goal-cas", ledgerPath);
		const emptyHead = stale.getCommittedHead();
		first.append({ type: "tool_call", goalId: "goal-cas", payload: { manager: 1 } });
		expect(() => stale.append({ type: "tool_call", goalId: "goal-cas", payload: { manager: 2 } }, emptyHead)).toThrow(
			/CAS|head|concurrent/i,
		);
		const reloaded = new ReplayLedgerManager("goal-cas", ledgerPath);
		reloaded.append({ type: "tool_call", goalId: "goal-cas", payload: { manager: 2 } });
		expect(new ReplayLedgerManager("goal-cas", ledgerPath).getEvents().map((event) => event.seq)).toEqual([1, 2]);
	});

	it("replays selected events with a typed handler", () => {
		const ledger = new ReplayLedgerManager("goal-replay", replayPath);
		ledger.append({ type: "tool_call", goalId: "goal-replay", payload: { tool: "A" } });
		ledger.append({ type: "tool_call", goalId: "goal-replay", payload: { tool: "B" } });
		ledger.append({ type: "message", goalId: "goal-replay", payload: { text: "hi" } });
		const tools = ledger.replay((event) => {
			const payload = event.payload;
			return event.type === "tool_call" &&
				typeof payload === "object" &&
				payload !== null &&
				"tool" in payload &&
				typeof payload.tool === "string"
				? payload.tool
				: undefined;
		});
		expect(tools).toEqual(["A", "B"]);
	});

	it.runIf(process.platform === "linux")("recovers a bounded lock record only after its child owner exits", () => {
		const lockPath = `${ledgerPath}.lock`;
		execFileSync(process.execPath, [
			"-e",
			`const fs=require("node:fs"),crypto=require("node:crypto"),stat=fs.readFileSync("/proc/"+process.pid+"/stat","utf8"),start=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\\s+/)[19];fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:2,pid:process.pid,processStartToken:"linux:"+start,acquiredAtMs:Date.now(),ownerId:crypto.randomUUID()})+"\\n",{mode:0o600});`,
			lockPath,
		]);

		const manager = new ReplayLedgerManager("goal-child-lock", ledgerPath);
		manager.append({ type: "tool_call", goalId: "goal-child-lock", payload: { owner: "parent" } });
		expect(manager.getEvents()).toHaveLength(1);
		expect(() => readFileSync(lockPath)).toThrow();
	});

	it("fails closed without removing a live or malformed lock owner", () => {
		const lockPath = `${ledgerPath}.lock`;
		writeFileSync(lockPath, lockRecord(process.pid, Date.now() - 86_400_000), { mode: 0o600 });
		expect(() => new ReplayLedgerManager("goal-live-lock", ledgerPath)).toThrow(/lock/i);
		expect(readFileSync(lockPath, "utf8")).toContain(`"pid":${process.pid}`);

		writeFileSync(lockPath, "{}\n", { mode: 0o600 });
		expect(() => new ReplayLedgerManager("goal-malformed-lock", ledgerPath)).toThrow(/lock|owner|record/i);
		expect(readFileSync(lockPath, "utf8")).toBe("{}\n");
	});

	it("recovers a fault-injected first append from a committed genesis prefix", () => {
		const firstLine = storeLine(1, HASH_1);
		const store = new ReplayLedgerStore(ledgerPath, inspectStore, {
			afterLedgerFsync: () => {
				throw new Error("first append crash");
			},
		});

		expect(() => store.append(firstLine, 1, HASH_1, EMPTY_REPLAY_LEDGER_HEAD)).toThrow(/first append crash/);
		const reopened = new ReplayLedgerStore(ledgerPath, inspectStore);
		expect(() => reopened.load(EMPTY_REPLAY_LEDGER_HEAD)).toThrow(/expected-head|CAS/i);
		const recovered = reopened.load();

		expect(recovered.bytes).toEqual(Buffer.alloc(0));
		expect(recovered.head.lastSeq).toBe(0);
		expect(recovered.head.lastHash).toBe("genesis");
		expect(recovered.head.fileIdentity).not.toBeNull();
	});

	it("rolls back a fault-injected uncommitted suffix without advancing an external head", async () => {
		let injectFault = false;
		let observedLock = Buffer.alloc(0);
		const store = new ReplayLedgerStore(ledgerPath, inspectStore, {
			afterLedgerFsync: () => {
				if (!injectFault) return;
				observedLock = readFileSync(`${ledgerPath}.lock`);
				throw new Error("fault after ledger fsync");
			},
		});
		const firstLine = storeLine(1, HASH_1);
		const secondLine = storeLine(2, HASH_2);
		const committed = store.append(firstLine, 1, HASH_1, {
			fileIdentity: null,
			size: 0,
			lastSeq: 0,
			lastHash: "genesis",
		});
		injectFault = true;

		expect(() => store.append(secondLine, 2, HASH_2, committed)).toThrow(/fault after ledger fsync/);
		expect(observedLock.byteLength).toBeGreaterThan(0);
		expect(observedLock.byteLength).toBeLessThanOrEqual(512);
		const forgedSuffixHead: ReplayLedgerHead = {
			...committed,
			size: committed.size + secondLine.byteLength,
			lastSeq: 2,
			lastHash: HASH_2,
		};
		const reopened = new ReplayLedgerStore(ledgerPath, inspectStore);
		expect(() => reopened.load(forgedSuffixHead)).toThrow(/expected-head|CAS/i);
		const recovered = reopened.load(committed);

		expect(replayLedgerHeadsEqual(recovered.head, committed)).toBe(true);
		expect(recovered.bytes).toEqual(firstLine);
		expect(await readFile(ledgerPath)).toEqual(firstLine);
	});
});
