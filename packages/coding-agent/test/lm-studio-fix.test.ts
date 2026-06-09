import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

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
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url.includes(":11434/api/tags")) {
				return Promise.resolve(
					new Response(JSON.stringify({ models: [{ name: "ollama-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url.includes(":1234/v1/models")) {
				return Promise.resolve(
					new Response(JSON.stringify({ data: [{ id: "lm-studio-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const allModels = registry.getAll();
		expect(allModels.some(m => m.provider === "ollama" && m.id === "ollama-model")).toBe(true);
		expect(allModels.some(m => m.provider === "lm-studio" && m.id === "lm-studio-model")).toBe(true);

		const available = registry.getAvailable();
		expect(available.some(m => m.provider === "ollama")).toBe(true);
		expect(available.some(m => m.provider === "lm-studio")).toBe(true);
	});

	test("LM_STUDIO_BASE_URL can target any local OpenAI-compatible /v1 server", async () => {
		const originalBaseUrl = Bun.env.LM_STUDIO_BASE_URL;
		Bun.env.LM_STUDIO_BASE_URL = "http://127.0.0.1:11434/v1";
		let requestedUrl = "";
		try {
			const fetchMock: FetchImpl = input => {
				const url = String(input);
				if (url.includes(":11434/v1/models")) {
					requestedUrl = url;
					return Promise.resolve(
						new Response(JSON.stringify({ data: [{ id: "omlx-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				return Promise.resolve(new Response(null, { status: 404 }));
			};

			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await registry.refresh();

			expect(requestedUrl).toBe("http://127.0.0.1:11434/v1/models");
			// Implicit discovery is still registered under the built-in lm-studio provider even when the base URL points to oMLX.
			expect(registry.getAll().some(m => m.provider === "lm-studio" && m.id === "omlx-model")).toBe(true);
		} finally {
			if (originalBaseUrl === undefined) {
				delete Bun.env.LM_STUDIO_BASE_URL;
			} else {
				Bun.env.LM_STUDIO_BASE_URL = originalBaseUrl;
			}
		}
	});
});
