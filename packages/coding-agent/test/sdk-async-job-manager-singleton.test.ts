import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager singleton across concurrent top-level sessions", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		AsyncJobManager.resetForTests();
	});

	async function spawnTopLevelSession(extraSettings?: Record<string, unknown>) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-singleton-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...(extraSettings ?? {}) }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return session;
	}

	it("keeps the primary session's manager installed after a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			const secondary = await spawnTopLevelSession();
			try {
				// While the secondary is alive the global instance MUST still point at
				// the primary's manager so background tools keep delivering completions
				// to the primary session that owns them.
				expect(AsyncJobManager.instance()).toBe(primaryManager);
			} finally {
				await secondary.dispose();
			}

			// After the secondary disposes, the primary's manager MUST still be the
			// reachable singleton — otherwise the `task` async path errors with
			// "Async execution is enabled but no async job manager is available".
			expect(AsyncJobManager.instance()).toBe(primaryManager);
		} finally {
			await primary.dispose();
		}

		// Once the owning primary session disposes the singleton clears, matching
		// the documented single-owner invariant.
		expect(AsyncJobManager.instance()).toBeUndefined();
	});

	it("does not cancel the primary session's running jobs when a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			// Register a long-running job on the primary's manager under the
			// MAIN_AGENT_ID owner — the same owner the secondary would inherit by
			// default. The secondary's dispose-time `cancelOwnAsyncJobs` must NOT
			// cancel this job (issue #1923).
			const release = Promise.withResolvers<string>();
			const jobId = primaryManager!.register(
				"bash",
				"sleep",
				async ({ signal }) => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([release.promise, aborted.promise]);
					return signal.aborted ? "aborted" : "completed";
				},
				{ ownerId: "Main" },
			);

			const secondary = await spawnTopLevelSession();
			await secondary.dispose();

			const job = primaryManager!.getJob(jobId);
			expect(job?.status).toBe("running");

			release.resolve("done");
			await primaryManager!.waitForAll();
		} finally {
			await primary.dispose();
		}
	});

	it("refuses async bash from a secondary session instead of routing it to the primary's manager", async () => {
		const primary = await spawnTopLevelSession({ "async.enabled": true });
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();
			const primaryJobCountBefore = primaryManager!.getAllJobs().length;

			const secondary = await spawnTopLevelSession({ "async.enabled": true });
			try {
				const bashTool = secondary.getToolByName("bash");
				expect(bashTool).toBeDefined();
				await expect(bashTool!.execute("call-1", { command: "echo hi", async: true })).rejects.toThrow(
					/Async job manager unavailable/,
				);
			} finally {
				await secondary.dispose();
			}

			// The secondary's failed async attempt must not have leaked a job into
			// the primary's manager.
			expect(primaryManager!.getAllJobs().length).toBe(primaryJobCountBefore);
		} finally {
			await primary.dispose();
		}
	});
});
