import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayLedgerLock } from "../src/guardrails/replay-ledger-lock.ts";

function linuxStartToken(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const fields = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/);
	const startTime = fields[19];
	if (startTime === undefined || !/^\d+$/.test(startTime)) throw new Error("invalid Linux process stat fixture");
	return `linux:${startTime}`;
}

function lockRecord(pid: number, processStartToken: string | null, ownerId = randomUUID()): string {
	return `${JSON.stringify({ schemaVersion: 2, pid, processStartToken, acquiredAtMs: Date.now(), ownerId })}\n`;
}

const CONTENDER = String.raw`
import { appendFileSync, closeSync, constants, openSync, readFileSync, unlinkSync } from "node:fs";
const [moduleUrl, lockPath, outputPath, id] = process.argv.slice(1);
const { ReplayLedgerLock } = await import(moduleUrl);
process.stdout.write("ready\n");
readFileSync(0);
new ReplayLedgerLock(lockPath).run(() => {
	const sentinel = outputPath + ".inside";
	const fd = openSync(sentinel, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		appendFileSync(outputPath, id);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
	} finally {
		closeSync(fd);
		unlinkSync(sentinel);
	}
});
`;

interface Contender {
	readonly ready: Promise<void>;
	readonly release: () => void;
	readonly exited: Promise<void>;
}

function contender(moduleUrl: string, lockPath: string, outputPath: string, id: string): Contender {
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", CONTENDER, moduleUrl, lockPath, outputPath, id],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	let rejectReady: (error: Error) => void = () => undefined;
	const ready = new Promise<void>((resolve, reject) => {
		rejectReady = reject;
		child.stdout.once("data", () => resolve());
	});
	const exited = new Promise<void>((resolve, reject) => {
		child.once("error", (error) => {
			rejectReady(error);
			reject(error);
		});
		child.once("close", (code) => {
			if (code === 0) resolve();
			else {
				const error = new Error(`replay lock contender exited ${code}: ${stderr}`);
				rejectReady(error);
				reject(error);
			}
		});
	});
	return { ready, release: () => child.stdin.end("go"), exited };
}

describe.runIf(process.platform === "linux")("ReplayLedgerLock identity-bound reclaim", () => {
	let root: string;
	let lockPath: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "omk-replay-lock-"));
		lockPath = join(root, "ledger.lock");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reclaims a reused PID only when its process-start token differs", () => {
		// Given: a lock from an earlier process incarnation that reused this live PID.
		writeFileSync(lockPath, lockRecord(process.pid, "linux:1"), { mode: 0o600 });
		const lock = new ReplayLedgerLock(lockPath);

		// When: the current process acquires the lock.
		let entered = false;
		lock.run(() => {
			entered = true;
		});

		// Then: start-token mismatch, not PID alone, proves the former owner is dead.
		expect(entered).toBe(true);
		expect(() => readFileSync(lockPath)).toThrow();
	});

	it("serializes two contenders reclaiming the same stale lock and reclaim gate", async () => {
		// Given: two processes released behind one barrier and stale owner identities on both lock layers.
		writeFileSync(lockPath, lockRecord(process.pid, "linux:1"), { mode: 0o600 });
		writeFileSync(`${lockPath}.reclaim`, lockRecord(process.pid, "linux:1"), { mode: 0o600 });
		const outputPath = join(root, "contenders.txt");
		const moduleUrl = new URL("../src/guardrails/replay-ledger-lock.ts", import.meta.url).href;
		const first = contender(moduleUrl, lockPath, outputPath, "a");
		const second = contender(moduleUrl, lockPath, outputPath, "b");
		await Promise.all([first.ready, second.ready]);

		// When: both contend without timing sleeps.
		first.release();
		second.release();
		await Promise.all([first.exited, second.exited]);

		// Then: each entered exactly once and neither removed the other's lock.
		expect((await readFile(outputPath, "utf8")).split("").sort()).toEqual(["a", "b"]);
		expect(() => readFileSync(lockPath)).toThrow();
	});

	it("holds ownership until an asynchronous operation settles", async () => {
		let resume: () => void = () => undefined;
		const barrier = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const pending = new ReplayLedgerLock(lockPath).run(async () => {
			await barrier;
		});

		expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
		resume();
		await pending;
		expect(() => readFileSync(lockPath)).toThrow();
	});

	it("re-reads owner and inode before reclaim and never unlinks a replacement", () => {
		// Given: a stale observation replaced by a live owner at the reclaim boundary.
		const currentToken = linuxStartToken(process.pid);
		const replacementOwnerId = randomUUID();
		writeFileSync(lockPath, lockRecord(process.pid, "linux:1"), { mode: 0o600 });
		const replacement = `${lockPath}.replacement`;
		writeFileSync(replacement, lockRecord(process.pid, currentToken, replacementOwnerId), { mode: 0o600 });
		let replaced = false;
		const lock = new ReplayLedgerLock(lockPath, {
			beforeReclaimRemove: () => {
				if (replaced) return;
				replaced = true;
				renameSync(replacement, lockPath);
			},
		});

		// When: reclaim reaches its final compare.
		expect(() => lock.run(() => undefined)).toThrow(/lock|unavailable/i);

		// Then: the replacement remains intact and was never unlinked.
		expect(JSON.parse(readFileSync(lockPath, "utf8")).ownerId).toBe(replacementOwnerId);
	});

	it("fails closed when process-start identity is unavailable", () => {
		// Given: an owner record explicitly lacking recoverable process identity.
		const ownerId = randomUUID();
		writeFileSync(lockPath, lockRecord(99_999_999, null, ownerId), { mode: 0o600 });
		const lock = new ReplayLedgerLock(lockPath, {
			processIdentity: () => ({ state: "unavailable" }),
		});

		// When/Then: uncertain liveness blocks recovery and preserves the owner record.
		expect(() => lock.run(() => undefined)).toThrow(/identity|liveness|lock/i);
		expect(JSON.parse(readFileSync(lockPath, "utf8")).ownerId).toBe(ownerId);
	});
});
