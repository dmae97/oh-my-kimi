import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeadlineProfileStore } from "./deadline-profile-store.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map((entry) => fs.promises.rm(entry, { force: true, recursive: true })));
});

describe("DeadlineProfileStore", () => {
	it("persists provider/model cutoff history across dispatcher processes", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-deadline-profile-"));
		cleanupPaths.push(dir);
		const filePath = path.join(dir, "profiles.json");
		const first = new DeadlineProfileStore(filePath);
		await first.record({
			provider: "openai-codex",
			model: "gpt-5.6",
			outcome: "cutoff",
			elapsedMs: 500,
			estimatedTokens: 100,
			workUnits: 2,
		});

		const reloaded = new DeadlineProfileStore(filePath);
		expect(await reloaded.profileFor("openai-codex", "gpt-5.6")).toMatchObject({ samples: 1, cutoffs: 1 });
	});

	it("serializes concurrent samples without losing updates", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-deadline-concurrent-"));
		cleanupPaths.push(dir);
		const filePath = path.join(dir, "profiles.json");
		const stores = [new DeadlineProfileStore(filePath), new DeadlineProfileStore(filePath)];
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				stores[index % stores.length].record({
					provider: "anthropic",
					model: "claude-sonnet",
					outcome: "completed",
					elapsedMs: 100 + index,
					estimatedTokens: 10,
					workUnits: 1,
				}),
			),
		);

		const reloaded = new DeadlineProfileStore(filePath);
		expect(await reloaded.profileFor("anthropic", "claude-sonnet")).toMatchObject({ samples: 8, completions: 8 });
	});

	it("recovers from malformed history without exposing untyped data", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-deadline-corrupt-"));
		cleanupPaths.push(dir);
		const filePath = path.join(dir, "profiles.json");
		await fs.promises.writeFile(filePath, "{not-json", "utf8");
		const store = new DeadlineProfileStore(filePath);

		expect(await store.profileFor("unknown", "default")).toBeUndefined();
		await store.record({
			provider: "unknown",
			model: "default",
			outcome: "failed",
			elapsedMs: 20,
			estimatedTokens: 5,
			workUnits: 1,
		});
		expect(JSON.parse(await fs.promises.readFile(filePath, "utf8"))).toMatchObject({ version: 1 });
	});
});
