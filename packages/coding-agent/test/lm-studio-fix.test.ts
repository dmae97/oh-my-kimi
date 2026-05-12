import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry LM Studio Fixes", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-lm-studio-fixes-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("auto-discovers both ollama and lm-studio models independently", async () => {
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes(":11434/api/tags")) {
				return new Response(JSON.stringify({ models: [{ name: "ollama-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes(":1234/v1/models")) {
				return new Response(JSON.stringify({ data: [{ id: "lm-studio-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		const allModels = registry.getAll();
		expect(allModels.some(m => m.provider === "ollama" && m.id === "ollama-model")).toBe(true);
		expect(allModels.some(m => m.provider === "lm-studio" && m.id === "lm-studio-model")).toBe(true);

		const available = registry.getAvailable();
		expect(available.some(m => m.provider === "ollama")).toBe(true);
		expect(available.some(m => m.provider === "lm-studio")).toBe(true);
	});
});
