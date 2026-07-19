import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayLedgerLock } from "../src/guardrails/replay-ledger-lock.ts";
import { parseLinuxProcessIdentityStat } from "../src/guardrails/replay-ledger-lock-owner.ts";
import { ReplayLedgerMutationGate } from "../src/guardrails/replay-ledger-mutation-gate.ts";

function linuxStartToken(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const startTime = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/)[19];
	if (startTime === undefined || !/^\d+$/.test(startTime)) throw new Error("invalid Linux process stat fixture");
	return `linux:${startTime}`;
}

function lockRecord(pid: number, processStartToken: string | null, ownerId = randomUUID()): string {
	return `${JSON.stringify({ schemaVersion: 2, pid, processStartToken, acquiredAtMs: Date.now(), ownerId })}\n`;
}

const GATE_CRASHER = `
const [moduleUrl, lockPath] = process.argv.slice(1);
const { ReplayLedgerLock } = await import(moduleUrl);
new ReplayLedgerLock(lockPath, {
	beforeReclaimRemove: () => process.kill(process.pid, "SIGKILL"),
}).run(() => undefined);
`;

describe.runIf(process.platform === "linux")("ReplayLedgerLock reclaim gate", () => {
	let root: string;
	let lockPath: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "omk-replay-gate-"));
		lockPath = join(root, "ledger.lock");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("treats an unreaped Linux zombie as positively dead", () => {
		const fields = Array.from({ length: 20 }, () => "0");
		fields[0] = "Z";
		fields[19] = "12345";
		expect(parseLinuxProcessIdentityStat(`321 (child worker) ${fields.join(" ")}`)).toEqual({ state: "absent" });
	});

	it("recovers an owner-identified reclaim gate after its child process dies", () => {
		writeFileSync(lockPath, lockRecord(process.pid, "linux:1"), { mode: 0o600 });
		const moduleUrl = new URL("../src/guardrails/replay-ledger-lock.ts", import.meta.url).href;
		const crashed = spawnSync(process.execPath, [
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			GATE_CRASHER,
			moduleUrl,
			lockPath,
		]);
		const strandedGate = JSON.parse(readFileSync(`${lockPath}.reclaim`, "utf8"));

		let entered = false;
		new ReplayLedgerLock(lockPath).run(() => {
			entered = true;
		});

		expect(crashed.signal).toBe("SIGKILL");
		expect(strandedGate).toMatchObject({
			schemaVersion: 2,
			pid: expect.any(Number),
			processStartToken: expect.stringMatching(/^linux:\d+$/),
			ownerId: expect.any(String),
		});
		expect(entered).toBe(true);
		expect(() => readFileSync(`${lockPath}.reclaim`)).toThrow();
	});

	it("holds gate ownership until an asynchronous operation settles", async () => {
		const gatePath = `${lockPath}.reclaim`;
		let resume: () => void = () => undefined;
		const barrier = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const pending = new ReplayLedgerMutationGate(gatePath).run(async () => {
			await barrier;
		});

		expect(JSON.parse(readFileSync(gatePath, "utf8")).pid).toBe(process.pid);
		resume();
		await pending;
		expect(() => readFileSync(gatePath)).toThrow();
	});

	it("binds reclaim-gate release to the acquired owner and inode", () => {
		const gatePath = `${lockPath}.reclaim`;
		const replacement = `${gatePath}.replacement`;
		let replacementBytes = "";
		let replaced = false;
		const lock = new ReplayLedgerLock(lockPath, {
			beforeMutationGateRelease: () => {
				if (replaced) return;
				replaced = true;
				replacementBytes = readFileSync(gatePath, "utf8");
				writeFileSync(replacement, replacementBytes, { mode: 0o600 });
				renameSync(replacement, gatePath);
			},
		});

		expect(() => lock.run(() => undefined)).toThrow(/ownership changed before release/i);
		expect(readFileSync(gatePath, "utf8")).toBe(replacementBytes);
	});

	it("re-reads reclaim-gate identity before removing a stale observation", () => {
		const gatePath = `${lockPath}.reclaim`;
		const replacementOwnerId = randomUUID();
		writeFileSync(gatePath, lockRecord(process.pid, "linux:1"), { mode: 0o600 });
		const replacement = `${gatePath}.replacement`;
		writeFileSync(replacement, lockRecord(process.pid, linuxStartToken(process.pid), replacementOwnerId), {
			mode: 0o600,
		});
		let replaced = false;
		const lock = new ReplayLedgerLock(lockPath, {
			beforeMutationGateReclaimRemove: () => {
				if (replaced) return;
				replaced = true;
				renameSync(replacement, gatePath);
			},
		});

		expect(() => lock.run(() => undefined)).toThrow(/lock|unavailable/i);
		expect(JSON.parse(readFileSync(gatePath, "utf8")).ownerId).toBe(replacementOwnerId);
	});

	it("recovers a tokenless reclaim gate only from positive absence evidence", () => {
		const gatePath = `${lockPath}.reclaim`;
		writeFileSync(gatePath, lockRecord(99_999_999, null), { mode: 0o600 });
		new ReplayLedgerLock(lockPath).run(() => undefined);
		expect(() => readFileSync(gatePath)).toThrow();

		const liveOwner = randomUUID();
		writeFileSync(gatePath, lockRecord(process.pid, null, liveOwner), { mode: 0o600 });
		expect(() => new ReplayLedgerLock(lockPath).run(() => undefined)).toThrow(/identity|liveness|lock/i);
		expect(JSON.parse(readFileSync(gatePath, "utf8")).ownerId).toBe(liveOwner);

		const uninspectableOwner = randomUUID();
		writeFileSync(gatePath, lockRecord(99_999_998, null, uninspectableOwner), { mode: 0o600 });
		const currentToken = linuxStartToken(process.pid);
		const lock = new ReplayLedgerLock(lockPath, {
			processIdentity: (pid) =>
				pid === process.pid ? { state: "present", startToken: currentToken } : { state: "unavailable" },
		});
		expect(() => lock.run(() => undefined)).toThrow(/identity|liveness|lock/i);
		expect(JSON.parse(readFileSync(gatePath, "utf8")).ownerId).toBe(uninspectableOwner);
	});
});
