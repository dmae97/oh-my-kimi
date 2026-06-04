import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs, type JsResult } from "../../src/eval/js/executor";

function statusEvents(result: JsResult) {
	return result.displayOutputs.filter(
		(output): output is Extract<JsResult["displayOutputs"][number], { type: "status" }> => output.type === "status",
	);
}

function baseSession(cwd: string, sessionFile: string, extra?: Partial<ToolSession>): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		...extra,
	} as ToolSession;
}

describe("executeJs workflow helpers", () => {
	let tempDir: TempDir;
	let sessionFile: string;
	let sessionId: string;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@js-workflow-helpers-");
		sessionFile = path.join(tempDir.path(), "session.jsonl");
		sessionId = `js-workflow-helpers:${tempDir.path()}`;
		// Share one warm worker across all cases. The JS eval worker loads
		// @babel/parser on spawn, so cold-start can exceed the 5s ready-timeout
		// floor under parallel CI load; paying it once here (with explicit
		// headroom) keeps the per-case bodies warm and immune to that race. The
		// budget bridge reads the per-run ToolSession, so a shared worker still
		// honors each case's distinct session config.
		await executeJs("1;", {
			sessionId,
			session: baseSession(tempDir.path(), sessionFile),
			sessionFile,
			timeoutMs: 30_000,
		});
	}, 60_000);

	afterAll(async () => {
		await disposeAllVmContexts();
		tempDir.removeSync();
	});

	it("emits log and phase status events", async () => {
		const session = baseSession(tempDir.path(), sessionFile);
		const result = await executeJs('log("hello"); phase("Scan");', {
			sessionId,
			session,
			sessionFile,
		});
		expect(result.exitCode).toBe(0);
		const events = statusEvents(result);
		const log = events.find(e => e.event.op === "log");
		const phase = events.find(e => e.event.op === "phase");
		expect(log?.event.message).toBe("hello");
		expect(phase?.event.title).toBe("Scan");
	});

	it("reads the turn budget from Goal Mode via the __budget__ bridge", async () => {
		const session = baseSession(tempDir.path(), sessionFile, {
			getGoalModeState: () => ({
				enabled: true,
				mode: "active",
				goal: {
					id: "g1",
					objective: "x",
					status: "active",
					tokenBudget: 100_000,
					tokensUsed: 4_200,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			}),
		});
		const result = await executeJs(
			"return JSON.stringify([await budget.total(), await budget.spent(), await budget.remaining()]);",
			{ sessionId, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("[100000,4200,95800]");
	});

	it("falls back to session output tokens with no ceiling when Goal Mode is inactive", async () => {
		const session = baseSession(tempDir.path(), sessionFile, {
			getUsageStatistics: () => ({
				input: 10,
				output: 777,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		});
		const result = await executeJs(
			"return JSON.stringify([await budget.total(), await budget.spent(), (await budget.remaining()) === Infinity]);",
			{ sessionId, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("[null,777,true]");
	});
});
