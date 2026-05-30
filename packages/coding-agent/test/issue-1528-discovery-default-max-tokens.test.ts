import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Issue #1528: auto-discovered OpenAI-compatible models defaulted to
 * `maxTokens: 8192`, which made providers (DeepSeek, etc.) drop the streaming
 * connection mid-response on large `write`/`edit` tool calls and surfaced as
 * Bun's opaque "socket connection was closed unexpectedly". The cap is now
 * `DISCOVERY_DEFAULT_MAX_TOKENS = 32_768` (`packages/coding-agent/src/config/
 * model-registry.ts`). These tests pin the externally observable default for
 * every discovery branch that previously hardcoded 8192.
 */
describe("issue #1528 discovery maxTokens default", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-issue-1528-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("openai-models-list discovery returns maxTokens=32768 when API advertises no output limit", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  deepseek-compat:",
				"    baseUrl: https://api.example.com/v1",
				"    apiKey: sk-test",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url !== "https://api.example.com/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refreshProvider("deepseek-compat");

		const model = registry.find("deepseek-compat", "deepseek-v4-pro");
		expect(model?.maxTokens).toBe(32_768);
	});

	test("proxy (anthropic+openai) discovery returns maxTokens=32768 for openai-routed models", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  newapi-proxy:",
				"    baseUrl: https://proxy.example.com/v1",
				"    apiKey: sk-test",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: proxy",
			].join("\n"),
		);

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url !== "https://proxy.example.com/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(
				JSON.stringify({
					data: [{ id: "deepseek-v4-pro", supported_endpoint_types: ["openai"] }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refreshProvider("newapi-proxy");

		const model = registry.find("newapi-proxy", "deepseek-v4-pro");
		expect(model?.maxTokens).toBe(32_768);
	});
});
