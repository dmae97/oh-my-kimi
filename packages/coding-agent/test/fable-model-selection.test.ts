import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { findInitialModel, resolveCliModel } from "../src/core/model-resolver.ts";

const tempDirectories: string[] = [];

function createRegistry(): ModelRegistry {
	const tempDirectory = mkdtempSync(join(tmpdir(), "omk-fable-selection-"));
	tempDirectories.push(tempDirectory);
	return ModelRegistry.inMemory(AuthStorage.create(join(tempDirectory, "auth.json")));
}

afterEach(() => {
	for (const tempDirectory of tempDirectories.splice(0)) {
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

describe("Fable model selection", () => {
	it("keeps Fable in the registry and resolves an explicit CLI selection", () => {
		const registry = createRegistry();

		const fable = registry.find("anthropic", "claude-fable-5");
		const resolved = resolveCliModel({
			cliProvider: "anthropic",
			cliModel: "claude-fable-5",
			modelRegistry: registry,
		});

		expect(fable).toBeDefined();
		expect(resolved).toMatchObject({ model: { provider: "anthropic", id: "claude-fable-5" } });
	});

	it("honors Fable when it is the saved default", async () => {
		const registry = createRegistry();

		const resolved = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: "claude-fable-5",
			modelRegistry: registry,
		});

		expect(resolved.model).toMatchObject({ provider: "anthropic", id: "claude-fable-5" });
	});

	it("does not choose Fable as an automatic fallback", async () => {
		const registry = createRegistry();
		const fable = registry.find("anthropic", "claude-fable-5");
		const safe = registry.find("minimax", "MiniMax-M2.7");
		expect(fable).toBeDefined();
		expect(safe).toBeDefined();
		if (!fable || !safe) throw new Error("expected built-in fallback models");
		const automaticRegistry = {
			getAvailable: () => [fable, safe],
		} as unknown as ModelRegistry;

		const resolved = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: automaticRegistry,
		});

		expect(resolved.model).toBe(safe);
	});
});
