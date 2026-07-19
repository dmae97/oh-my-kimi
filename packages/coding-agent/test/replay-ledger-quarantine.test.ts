import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_REPLAY_LEDGER_HEAD, ReplayLedgerStore } from "../src/guardrails/replay-ledger-store.ts";

const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

function inspectStore(bytes: Buffer): { readonly lastSeq: number; readonly lastHash: string } {
	if (bytes.byteLength === 0) return { lastSeq: 0, lastHash: "genesis" };
	const value: unknown = JSON.parse(bytes.toString("utf8").trim().split("\n").at(-1) ?? "null");
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

describe("ReplayLedgerStore suffix quarantine", () => {
	let root: string;
	let ledgerPath: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "omk-replay-quarantine-"));
		ledgerPath = join(root, "ledger.jsonl");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("does not truncate an uncommitted suffix when quarantine fsync fails", async () => {
		// Given: one committed line followed by a fault-injected uncommitted suffix.
		let injectAppendFault = false;
		const writer = new ReplayLedgerStore(ledgerPath, inspectStore, {
			afterLedgerFsync: () => {
				if (injectAppendFault) throw new Error("append publication fault");
			},
		});
		const firstLine = storeLine(1, HASH_1);
		const secondLine = storeLine(2, HASH_2);
		const committed = writer.append(firstLine, 1, HASH_1, EMPTY_REPLAY_LEDGER_HEAD);
		injectAppendFault = true;
		expect(() => writer.append(secondLine, 2, HASH_2, committed)).toThrow(/publication fault/);
		const uncommittedBytes = await readFile(ledgerPath);

		// When: durable quarantine is faulted before its fsync.
		const blocked = new ReplayLedgerStore(ledgerPath, inspectStore, {
			beforeQuarantineFsync: () => {
				throw new Error("quarantine fsync fault");
			},
		});

		// Then: recovery fails closed without truncating a byte.
		expect(() => blocked.load(committed)).toThrow(/quarantine fsync fault/);
		expect(await readFile(ledgerPath)).toEqual(uncommittedBytes);
	});

	it("fsyncs an owner-only suffix artifact before rollback", () => {
		// Given: a recoverable uncommitted suffix.
		let injectAppendFault = false;
		const writer = new ReplayLedgerStore(ledgerPath, inspectStore, {
			afterLedgerFsync: () => {
				if (injectAppendFault) throw new Error("append publication fault");
			},
		});
		const firstLine = storeLine(1, HASH_1);
		const secondLine = storeLine(2, HASH_2);
		const committed = writer.append(firstLine, 1, HASH_1, EMPTY_REPLAY_LEDGER_HEAD);
		injectAppendFault = true;
		expect(() => writer.append(secondLine, 2, HASH_2, committed)).toThrow(/publication fault/);

		// When: the store rolls back to the externally supplied committed head.
		const recovered = new ReplayLedgerStore(ledgerPath, inspectStore).load(committed);

		// Then: the suffix survives in a durable owner-only artifact before truncation.
		expect(recovered.bytes).toEqual(firstLine);
		expect(readFileSync(ledgerPath)).toEqual(firstLine);
		const artifacts = readdirSync(root).filter((name) => name.startsWith(`${basename(ledgerPath)}.quarantine.`));
		expect(artifacts).toHaveLength(1);
		const artifactPath = join(root, artifacts[0]);
		expect(statSync(artifactPath).mode & 0o077).toBe(0);
		expect(readFileSync(artifactPath)).toEqual(secondLine);
	});
});
