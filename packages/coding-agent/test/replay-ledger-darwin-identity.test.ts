import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	inspectProcessIdentity,
	parseDarwinProcessIdentityLstart,
} from "../src/guardrails/replay-ledger-lock-owner.ts";
import { ReplayLedgerMutationGate } from "../src/guardrails/replay-ledger-mutation-gate.ts";

const PROCESS_START_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

describe("parseDarwinProcessIdentityLstart", () => {
	it("treats empty ps output as an absent process", () => {
		expect(parseDarwinProcessIdentityLstart("")).toEqual({ state: "absent" });
		expect(parseDarwinProcessIdentityLstart("   \n")).toEqual({ state: "absent" });
	});

	it("fails closed on unparseable output", () => {
		expect(parseDarwinProcessIdentityLstart("not a date")).toEqual({ state: "unavailable" });
		expect(parseDarwinProcessIdentityLstart("x".repeat(513))).toEqual({ state: "unavailable" });
	});

	it("derives a stable darwin:<epochMs> token from BSD lstart output", () => {
		const identity = parseDarwinProcessIdentityLstart("Wed Aug 12 14:30:00 2026\n");
		expect(identity).toEqual({ state: "present", startToken: `darwin:${Date.parse("Wed Aug 12 14:30:00 2026")}` });
		if (identity.state === "present") {
			expect(identity.startToken).toMatch(PROCESS_START_TOKEN);
		}
	});
});

describe.runIf(process.platform === "darwin")("Darwin process identity reader", () => {
	it("returns the current process's lstart token", () => {
		const identity = inspectProcessIdentity(process.pid);
		expect(identity.state).toBe("present");
		if (identity.state === "present") {
			expect(identity.startToken).toMatch(/^darwin:\d+$/);
			expect(identity.startToken).toMatch(PROCESS_START_TOKEN);
		}
	});

	it("treats an exited child's pid as absent", () => {
		const child = spawnSync("true");
		expect(child.status).toBe(0);
		expect(inspectProcessIdentity(child.pid ?? 0)).toEqual({ state: "absent" });
	});

	it("rejects invalid pids fail-closed", () => {
		expect(inspectProcessIdentity(0)).toEqual({ state: "unavailable" });
		expect(inspectProcessIdentity(-1)).toEqual({ state: "unavailable" });
		expect(inspectProcessIdentity(Number.NaN)).toEqual({ state: "unavailable" });
	});
});

describe.runIf(process.platform === "darwin")("ReplayLedgerMutationGate on Darwin", () => {
	let root: string;
	let gatePath: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "omk-replay-darwin-gate-"));
		gatePath = join(root, "ledger.lock");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("acquires and releases the replay lock with the default reader", async () => {
		const result = await new ReplayLedgerMutationGate(gatePath).run(async () => {
			expect(existsSync(gatePath)).toBe(true);
			return "ok";
		});
		expect(result).toBe("ok");
		expect(existsSync(gatePath)).toBe(false);
	});
});

it.runIf(process.platform === "linux")("keeps the Linux reader behavior unchanged", () => {
	const identity = inspectProcessIdentity(process.pid);
	expect(identity.state).toBe("present");
	if (identity.state === "present") {
		expect(identity.startToken).toMatch(/^linux:\d+$/);
	}
});
