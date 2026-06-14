/**
 * Issue #2462: prompt templates discovered from `cwd/.omp/prompts/` were never
 * surfaced in the slash-command autocomplete picker. The runtime expansion in
 * `AgentSession.prompt()` worked, but `InteractiveMode.refreshSlashCommandState`
 * never passed `session.promptTemplates` into the autocomplete provider.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { z } from "zod/v4";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

describe("InteractiveMode prompt-template autocomplete (#2462)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		Bun.gc(true);
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-prompt-template-autocomplete-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		authStorage = undefined as unknown as AuthStorage;
		tempDir = undefined as unknown as TempDir;
		resetSettingsForTest();
		Bun.gc(true);
	});

	function modelOrThrow(registry: ModelRegistry, id: string): Model<Api> {
		const model = registry.find("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createHarness(
		templates: PromptTemplate[],
	): Promise<{ mode: InteractiveMode; session: AgentSession }> {
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
		const model = modelOrThrow(registry, "claude-sonnet-4-5");
		const tools = [makeTool("read")];
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		const created = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools,
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			promptTemplates: templates,
		});
		const createdMode = new InteractiveMode(created, "test");
		session = created;
		mode = createdMode;
		return { mode: createdMode, session: created };
	}

	function captureAutocompleteProvider(target: InteractiveMode): { current: AutocompleteProvider | undefined } {
		const slot: { current: AutocompleteProvider | undefined } = { current: undefined };
		vi.spyOn(target.editor, "setAutocompleteProvider").mockImplementation(provider => {
			slot.current = provider;
		});
		return slot;
	}

	async function fetchSlashSuggestions(provider: AutocompleteProvider, query: string): Promise<string[]> {
		const result = await provider.getSuggestions([query], 0, query.length);
		if (!result) return [];
		return result.items.map(item => item.value);
	}

	it("includes discovered prompt templates in slash-command autocomplete", async () => {
		const created = await createHarness([
			{
				name: "review",
				description: "Review code for bugs (project)",
				content: "Please review the following code:\n",
				source: "(project)",
			},
		]);
		const slot = captureAutocompleteProvider(created.mode);

		await created.mode.refreshSlashCommandState(tempDir.path());

		const provider = slot.current;
		expect(provider).toBeDefined();

		// Empty `/` shows the full menu.
		const all = await fetchSlashSuggestions(provider!, "/");
		expect(all).toContain("review");

		// Fuzzy prefix `/rev` also surfaces the template.
		const prefixMatches = await fetchSlashSuggestions(provider!, "/rev");
		expect(prefixMatches).toContain("review");
	});

	it("does not duplicate templates whose names collide with builtin slash commands", async () => {
		const created = await createHarness([
			{
				name: "exit",
				description: "Custom exit template (project)",
				content: "ignored",
				source: "(project)",
			},
		]);
		const slot = captureAutocompleteProvider(created.mode);

		await created.mode.refreshSlashCommandState(tempDir.path());

		const provider = slot.current;
		expect(provider).toBeDefined();
		const matches = await fetchSlashSuggestions(provider!, "/exit");
		// Builtin `/exit` stays; the colliding template is filtered out so the picker
		// shows a single entry rather than two `exit` rows.
		expect(matches.filter(name => name === "exit")).toHaveLength(1);
	});

	it("does not duplicate templates whose names collide with builtin slash command aliases", async () => {
		const created = await createHarness([
			{
				name: "models",
				description: "Custom models template (project)",
				content: "ignored",
				source: "(project)",
			},
		]);
		const slot = captureAutocompleteProvider(created.mode);

		await created.mode.refreshSlashCommandState(tempDir.path());

		const provider = slot.current;
		expect(provider).toBeDefined();
		const matches = await fetchSlashSuggestions(provider!, "/models");
		// Builtin `/model` owns the `/models` alias. The colliding template is filtered
		// out so autocomplete follows the interactive slash-command resolution path.
		expect(matches.filter(name => name === "models")).toHaveLength(1);
	});
});
