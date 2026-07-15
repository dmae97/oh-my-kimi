import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const packageRoot = path.resolve(import.meta.dir, "..");

let tempDir: TempDir;

describe("ModelRegistry default custom models config", () => {
	beforeEach(() => {
		tempDir = TempDir.createSync("@model-registry-default-config-");
	});

	afterEach(async () => {
		await tempDir.remove().catch(() => {});
	});

	test("loads custom provider models from default models.yaml when models.yml is absent", () => {
		writeModelsYaml("models.yaml", {
			provider: "yaml-default-only",
			modelId: "yaml-model",
			modelName: "YAML default model",
			baseUrl: "https://yaml-default.example.com/v1",
		});

		const model = loadDefaultRegistryModel({
			provider: "yaml-default-only",
			modelId: "yaml-model",
		});

		expect(model?.name).toBe("YAML default model");
		expect(model?.baseUrl).toBe("https://yaml-default.example.com/v1");
	});

	test("prefers default models.yml over models.yaml when both exist", () => {
		writeModelsYaml("models.yml", {
			provider: "yaml-precedence",
			modelId: "from-yml",
			modelName: "YML winner",
			baseUrl: "https://yml-winner.example.com/v1",
		});
		writeModelsYaml("models.yaml", {
			provider: "yaml-precedence",
			modelId: "from-yaml",
			modelName: "YAML loser",
			baseUrl: "https://yaml-loser.example.com/v1",
		});

		const ymlModel = loadDefaultRegistryModel({
			provider: "yaml-precedence",
			modelId: "from-yml",
		});
		const yamlModel = loadDefaultRegistryModel({
			provider: "yaml-precedence",
			modelId: "from-yaml",
		});

		expect(ymlModel?.baseUrl).toBe("https://yml-winner.example.com/v1");
		expect(yamlModel).toBeUndefined();
	});

	test("prefers default models.yaml over legacy models.json when models.yml is absent", () => {
		writeModelsYaml("models.yaml", {
			provider: "yaml-json-precedence",
			modelId: "from-yaml",
			modelName: "YAML winner over JSON",
			baseUrl: "https://yaml-over-json.example.com/v1",
		});
		writeModelsJson({
			provider: "yaml-json-precedence",
			modelId: "from-json",
			modelName: "JSON loser",
			baseUrl: "https://json-loser.example.com/v1",
		});

		const yamlModel = loadDefaultRegistryModel({
			provider: "yaml-json-precedence",
			modelId: "from-yaml",
		});
		const jsonModel = loadDefaultRegistryModel({
			provider: "yaml-json-precedence",
			modelId: "from-json",
		});

		expect(yamlModel?.baseUrl).toBe("https://yaml-over-json.example.com/v1");
		expect(jsonModel).toBeUndefined();
	});
});

interface ProviderFixture {
	provider: string;
	modelId: string;
	modelName: string;
	baseUrl: string;
}

interface ModelLookup {
	provider: string;
	modelId: string;
}

interface ModelSnapshot {
	provider: string;
	id: string;
	name: string;
	baseUrl: string | undefined;
}

function writeModelsYaml(file: "models.yml" | "models.yaml", fixture: ProviderFixture): void {
	fs.writeFileSync(
		path.join(tempDir.path(), file),
		[
			"providers:",
			`  ${fixture.provider}:`,
			`    baseUrl: ${fixture.baseUrl}`,
			"    apiKey: TEST_KEY",
			"    api: anthropic-messages",
			"    models:",
			`      - id: ${fixture.modelId}`,
			`        name: ${fixture.modelName}`,
			"        reasoning: false",
			"        input: [text]",
			"        cost:",
			"          input: 0",
			"          output: 0",
			"          cacheRead: 0",
			"          cacheWrite: 0",
			"        contextWindow: 100000",
			"        maxTokens: 8000",
			"",
		].join("\n"),
	);
}

function writeModelsJson(fixture: ProviderFixture): void {
	fs.writeFileSync(
		path.join(tempDir.path(), "models.json"),
		JSON.stringify({
			providers: {
				[fixture.provider]: {
					baseUrl: fixture.baseUrl,
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [
						{
							id: fixture.modelId,
							name: fixture.modelName,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 8000,
						},
					],
				},
			},
		}),
	);
}

function loadDefaultRegistryModel(lookup: ModelLookup): ModelSnapshot | undefined {
	const script = `
		import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
		import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage);
			const model = registry.find(${JSON.stringify(lookup.provider)}, ${JSON.stringify(lookup.modelId)});
			process.stdout.write(JSON.stringify(model ? {
				provider: model.provider,
				id: model.id,
				name: model.name,
				baseUrl: model.baseUrl,
			} : null));
		} finally {
			authStorage.close();
		}
	`;
	const result = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: packageRoot,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: tempDir.path(),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(result.stdout).trim();
	const stderr = new TextDecoder().decode(result.stderr).trim();
	if (result.exitCode !== 0) {
		throw new Error(`default ModelRegistry lookup failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
	}
	return JSON.parse(stdout) ?? undefined;
}
