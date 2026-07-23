import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCheckpointTask,
	checkpointMadeProgress,
	createCheckpointWorkspace,
	readCheckpoint,
	removeCheckpointWorkspace,
} from "./checkpoint-runtime.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map((entry) => fs.promises.rm(entry, { force: true, recursive: true })));
});

describe("subagent checkpoint runtime", () => {
	it("loads a bounded, typed checkpoint written by a child", async () => {
		const workspace = await createCheckpointWorkspace(path.join(os.tmpdir(), "omk-checkpoint-test-"));
		cleanupPaths.push(workspace.dir);
		await fs.promises.writeFile(
			workspace.filePath,
			JSON.stringify({
				version: 1,
				completed: ["inspect boundary"],
				remaining: ["add tests"],
				summary: "boundary inspected",
				artifacts: ["src/runtime.ts"],
			}),
			"utf8",
		);

		const checkpoint = await readCheckpoint(workspace.filePath, {
			messageCount: 3,
			outputTail: "stream tail",
			lastEventAtMs: 123,
		});

		expect(checkpoint).toMatchObject({
			completed: ["inspect boundary"],
			remaining: ["add tests"],
			summary: "boundary inspected",
			artifacts: ["src/runtime.ts"],
			messageCount: 3,
			outputTail: "stream tail",
			lastEventAtMs: 123,
		});
	});

	it("rejects a checkpoint path replaced with a symbolic link", async () => {
		const workspace = await createCheckpointWorkspace(path.join(os.tmpdir(), "omk-checkpoint-symlink-"));
		cleanupPaths.push(workspace.dir);
		const targetPath = path.join(workspace.dir, "target.json");
		await fs.promises.writeFile(
			targetPath,
			JSON.stringify({ version: 1, completed: ["untrusted target"], remaining: [], summary: "leak", artifacts: [] }),
			"utf8",
		);
		await fs.promises.rm(workspace.filePath);
		await fs.promises.symlink(targetPath, workspace.filePath);

		const checkpoint = await readCheckpoint(workspace.filePath, {
			messageCount: 0,
			outputTail: "",
			lastEventAtMs: 0,
		});

		expect(checkpoint.completed).toEqual([]);
		expect(checkpoint.summary).toBe("");
	});

	it("builds a bounded resume prompt that forbids replaying completed side effects", () => {
		const hugeTail = `old-output-${"x".repeat(20_000)}`;
		const prompt = buildCheckpointTask({
			originalTask: "Implement the deadline runtime.",
			shardTask: "Add the process cleanup path.",
			shardId: "shard-2",
			shardIndex: 1,
			shardCount: 3,
			attempt: 2,
			cutoffMs: 30_000,
			checkpointFilePath: "/tmp/checkpoint.json",
			checkpoint: {
				version: 1,
				completed: ["sent SIGTERM"],
				remaining: ["verify SIGKILL"],
				summary: "graceful termination implemented",
				artifacts: ["process-runtime.ts"],
				messageCount: 4,
				outputTail: hugeTail,
				lastEventAtMs: 100,
			},
		});

		expect(prompt).toContain("Do not repeat completed side effects");
		expect(prompt).toContain("sent SIGTERM");
		expect(prompt).toContain("verify SIGKILL");
		expect(prompt).toContain("Only unresolved checkpoint units");
		expect(prompt).not.toContain("Add the process cleanup path.");
		expect(prompt.length).toBeLessThan(12_000);
	});

	it("blocks duplicate resume when neither checkpoint nor streamed evidence advanced", () => {
		const before = {
			version: 1 as const,
			completed: ["a"],
			remaining: ["b"],
			summary: "same",
			artifacts: [],
			messageCount: 2,
			outputTail: "same tail",
			lastEventAtMs: 10,
		};
		expect(checkpointMadeProgress(before, { ...before })).toBe(false);
		expect(checkpointMadeProgress(before, { ...before, messageCount: 3 })).toBe(true);
	});

	it("removes checkpoint artifacts after the logical task settles", async () => {
		const workspace = await createCheckpointWorkspace(path.join(os.tmpdir(), "omk-checkpoint-cleanup-"));
		await removeCheckpointWorkspace(workspace);
		expect(fs.existsSync(workspace.dir)).toBe(false);
	});
});
