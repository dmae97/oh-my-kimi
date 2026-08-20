/**
 * Grok harness auto-dispatch: when provider is native xai and OMK_GROK_HARNESS is not off,
 * tryGrokHarnessDispatch applies the grok-harness domain loadout without OMK_DOMAIN_ROUTING=1.
 */
import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { tryGrokHarnessDispatch } from "../src/core/grok-harness-dispatch.ts";
import { GROK_OAUTH_PROVIDER } from "../src/core/grok-playbook.ts";
import type { LoadoutRuntimeSession } from "../src/core/loadout-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import type { SourceInfo } from "../src/core/source-info.ts";

vi.mock("../src/core/mcp-inventory.ts", () => ({
	loadMcpInventory: () => ({
		entries: [
			{ name: "adaptorch", source: "/project/.omk/mcp.json", commandSummary: "adaptorch", envKeys: [] },
			{ name: "fetch", source: "/project/.omk/mcp.json", commandSummary: "fetch", envKeys: [] },
			{ name: "understand-anything", source: "/project/.omk/mcp.json", commandSummary: "ua", envKeys: [] },
			{ name: "playwright", source: "/project/.omk/mcp.json", commandSummary: "playwright", envKeys: [] },
			{ name: "filesystem", source: "/project/.omk/mcp.json", commandSummary: "fs", envKeys: [] },
		],
		presets: [],
		sources: [],
		errors: [],
	}),
}));

const sourceInfo = (name: string): SourceInfo => ({
	source: "test",
	scope: "project",
	origin: "top-level",
	path: `/skills/${name}`,
});

const makeSession = (
	baseTools: readonly string[] = ["read", "grep", "find", "ls", "edit", "write", "bash"],
): LoadoutRuntimeSession => {
	const base = new Map<string, ToolDefinition>();
	for (const name of baseTools) base.set(name, { name } as unknown as ToolDefinition);
	return {
		_baseToolDefinitions: base,
		_extensionRunner: { getAllRegisteredTools: () => [] },
		_customTools: [],
	};
};

const makeResourceLoader = (): ResourceLoader => ({
	getSkills: () => ({
		skills: ["packages", "programming", "debugging", "adaptorch-route", "understand-anything", "headroom"].map(
			(name) => ({
				name,
				description: "test skill",
				filePath: `/skills/${name}/SKILL.md`,
				baseDir: "/skills",
				disableModelInvocation: false,
				sourceInfo: sourceInfo(name),
			}),
		),
		diagnostics: [],
	}),
	getExtensions: () => ({ extensions: [], diagnostics: [], errors: [], runtime: {} as never }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => undefined,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
});

describe("tryGrokHarnessDispatch", () => {
	it("is a no-op for non-Grok providers", () => {
		const result = tryGrokHarnessDispatch({
			provider: "anthropic",
			session: makeSession(),
			resourceLoader: makeResourceLoader(),
			cwd: "/project",
			agentDir: "/agent",
			env: {},
		});
		expect(result.loadoutAccessPolicy).toBeUndefined();
		expect(result.warnings).toEqual([]);
	});

	it("is a no-op when OMK_GROK_HARNESS is disabled", () => {
		const result = tryGrokHarnessDispatch({
			provider: GROK_OAUTH_PROVIDER,
			session: makeSession(),
			resourceLoader: makeResourceLoader(),
			cwd: "/project",
			agentDir: "/agent",
			env: { OMK_GROK_HARNESS: "0" },
		});
		expect(result.loadoutAccessPolicy).toBeUndefined();
	});

	it("applies grok-harness loadout for native xai without domain routing opt-in", () => {
		const result = tryGrokHarnessDispatch({
			provider: GROK_OAUTH_PROVIDER,
			session: makeSession(),
			resourceLoader: makeResourceLoader(),
			cwd: "/project",
			agentDir: "/agent",
			env: {},
		});
		expect(result.loadoutAccessPolicy).toBeDefined();
		expect(result.loadoutAccessPolicy?.activeTools).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write"]),
		);
		expect(result.runtimeState?.profileName).toMatch(/grok|coder/i);
	});
});
