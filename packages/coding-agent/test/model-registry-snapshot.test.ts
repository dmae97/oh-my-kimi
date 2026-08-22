import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

function modelsConfig(modelIds: string[]): string {
	return JSON.stringify({
		providers: {
			"snapshot-test-provider": {
				name: "Snapshot Test",
				baseUrl: "https://example.invalid/v1",
				api: "openai-completions",
				apiKey: "test-key",
				models: modelIds.map((id) => ({ id, name: id })),
			},
		},
	});
}

describe("model-registry models.json snapshots", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "omk-registry-snapshot-"));
		writeFileSync(join(tempDir, "models.json"), modelsConfig(["model-a", "model-b"]));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function createRegistry(): ModelRegistry {
		return ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json")), join(tempDir, "models.json"));
	}

	it("writes a timestamped snapshot on every successful load", () => {
		createRegistry().getAll();
		const snapshotDir = join(tempDir, "models.json.snapshots");
		expect(existsSync(snapshotDir)).toBe(true);
		const files = readdirSync(snapshotDir);
		expect(files.length).toBe(1);
		expect(readFileSync(join(snapshotDir, files[0] ?? ""), "utf8")).toContain("model-b");
	});

	it("warns when a load drops previously-present model entries", () => {
		createRegistry().getAll();
		writeFileSync(join(tempDir, "models.json"), modelsConfig(["model-a"]));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		createRegistry().getAll();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const message = String(warnSpy.mock.calls[0]?.[0]);
		expect(message).toContain("snapshot-test-provider/model-b");
		expect(message).toContain("models.json.snapshots");
	});

	it("stays silent when content is unchanged", () => {
		createRegistry().getAll();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		createRegistry().getAll();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("keeps the snapshot directory bounded", () => {
		for (let round = 0; round < 13; round++) {
			writeFileSync(join(tempDir, "models.json"), modelsConfig([`model-${round}`]));
			createRegistry().getAll();
		}
		const files = readdirSync(join(tempDir, "models.json.snapshots"));
		expect(files.length).toBeLessThanOrEqual(10);
	});
});
