import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { prompt } from "@oh-my-pi/pi-utils";
import Handlebars from "handlebars";

const baseGitContext = {
	isRepo: true,
	currentBranch: "feature/tests",
	mainBranch: "main",
	status: "M packages/coding-agent/src/prompts/system/custom-system-prompt.md",
	commits: "abc123 Fix tests",
};

const systemPromptsDir = path.resolve(import.meta.dir, "../src/prompts/system");

const baseRenderContext: prompt.TemplateContext = {
	TASK_TOOL_NAME: "task",
	ARGUMENTS: "alpha beta",
	agent: "You are a delegated worker",
	agentsMdSearch: { files: [] },
	appendPrompt: "Appendix instructions",
	arguments: "alpha beta",
	base: "Base system prompt",
	content: "Rule content",
	context: "Background context",
	contextFile: "/tmp/context.md",
	contextFiles: [{ path: "/tmp/context/a.md", content: "Alpha context" }],
	customPrompt: "Custom prompt body",
	cwd: "/tmp/pi-issue-147",
	date: "2026-02-24",
	dateTime: "2026-02-24T12:00:00Z",
	editToolName: "edit",
	environment: [{ label: "OS", value: "Darwin" }],
	finalPlanFilePath: "local://PLAN_FINAL.md",
	git: baseGitContext,
	intentField: INTENT_FIELD,
	intentTracing: true,
	iterative: true,
	maxRetries: 3,
	modifiedFiles: ["packages/coding-agent/src/config/prompt-templates.ts"],
	name: "rs-no-unwrap",
	path: "packages/coding-agent/src/config/prompt-templates.ts",
	planContent: "1. Read code\n2. Add tests",
	planExists: true,
	planFilePath: "local://PLAN.md",
	readFiles: ["packages/coding-agent/src/prompts/system/custom-system-prompt.md"],
	repeatToolDescriptions: true,
	reentry: false,
	request: "Create an agent to review prompt templates",
	retryCount: 1,
	rules: [{ name: "rs-no-unwrap", description: "Avoid unwrap", globs: ["**/*.rs"] }],
	skills: [{ name: "system-prompts", description: "Prompt design skill" }],
	systemPromptCustomization: "System customization",
	toolInfo: [{ name: "read", label: "Read", description: "Reads files" }],
	tools: ["read", "search", "find", "edit", "task", "web_search", "todo_write"],
	worktree: "/tmp/pi-issue-147",
	writeToolName: "write",
};

async function loadSystemPromptTemplates(): Promise<Map<string, string>> {
	const templates = new Map<string, string>();
	const glob = new Bun.Glob("*.md");

	for await (const fileName of glob.scan({ cwd: systemPromptsDir, onlyFiles: true })) {
		const templatePath = path.join(systemPromptsDir, fileName);
		templates.set(fileName, await Bun.file(templatePath).text());
	}

	return templates;
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) return 0;
	return text.split(needle).length - 1;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-system-prompt-"));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("system Handlebars prompt templates", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("parses and compiles every system template", async () => {
		const templates = await loadSystemPromptTemplates();
		expect(templates.size).toBeGreaterThan(0);

		for (const [fileName, template] of templates) {
			expect(() => Handlebars.parse(template), `Failed parsing ${fileName}`).not.toThrow();
			expect(() => Handlebars.compile(template), `Failed compiling ${fileName}`).not.toThrow();
		}
	});

	test("custom-system-prompt renders project section for context and git combinations", async () => {
		const templatePath = path.join(systemPromptsDir, "custom-system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const both = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [{ path: "a.txt", content: "A" }],
			git: { ...baseGitContext, isRepo: true },
		});
		expect(both).toContain("<project>");
		expect(both).toContain("## Context");
		expect(both).toContain("## Version Control");

		const contextOnly = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [{ path: "a.txt", content: "A" }],
			git: { isRepo: false },
		});
		expect(contextOnly).toContain("<project>");
		expect(contextOnly).toContain("## Context");
		expect(contextOnly).not.toContain("## Version Control");

		const gitOnly = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [],
			git: {
				isRepo: true,
				currentBranch: "feature/tests",
				mainBranch: "main",
				status: "clean",
				commits: "abc123 test commit",
			},
		});
		expect(gitOnly).toContain("<project>");
		expect(gitOnly).not.toContain("## Context");
		expect(gitOnly).toContain("## Version Control");

		const neither = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [],
			git: { isRepo: false },
		});
		expect(neither).not.toContain("<project>");
		expect(neither).not.toContain("## Context");
		expect(neither).not.toContain("## Version Control");
	});

	test("system-prompt conditionally renders inspect_image guidance", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const baseTools = baseRenderContext.tools as string[];
		const withInspectImage = prompt.render(template, {
			...baseRenderContext,
			tools: [...baseTools, "inspect_image"],
		});
		expect(withInspectImage).toContain("### Image inspection");
		expect(withInspectImage).toContain("**MUST** use `inspect_image` over `read`");
		expect(withInspectImage).toContain("Write a specific `question` for `inspect_image`");

		const withoutInspectImage = prompt.render(template, {
			...baseRenderContext,
			tools: baseTools.filter((tool: string) => tool !== "inspect_image"),
		});
		expect(withoutInspectImage).not.toContain("### Image inspection");
	});

	test("system-prompt renders MCP discovery hint when enabled", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = prompt.render(template, {
			...baseRenderContext,
			mcpDiscoveryMode: true,
			hasMCPDiscoveryServers: true,
			mcpDiscoveryServerSummaries: ["github (2 tools)", "slack (1 tool)"],
		});

		expect(rendered).toContain("### MCP tool discovery");
		expect(rendered).toContain("Discoverable MCP servers in this session: github (2 tools), slack (1 tool).");
		expect(rendered).not.toContain("Example discoverable MCP tools:");
		expect(rendered).toContain("call `search_tool_bm25` before concluding no such tool exists");
	});

	test("buildSystemPrompt deduplicates always-apply rules already present in SYSTEM.md", async () => {
		const duplicateRule = ["Use static imports.", "", "Do not use dynamic loading."].join("\n");
		const distinctRule = "Validate inputs at boundaries.";

		await withTempDir(async dir => {
			const configDir = path.join(dir, ".agent");
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(
				path.join(configDir, "SYSTEM.md"),
				["Project instructions", "", duplicateRule, "", "Trailing note"].join("\n"),
			);

			const prompt = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				customPrompt: "Custom prompt body",
				alwaysApplyRules: [
					{ name: "no-dynamic-loading", content: duplicateRule, path: "/tmp/no-dynamic-loading.md" },
					{ name: "validate-boundaries", content: distinctRule, path: "/tmp/validate-boundaries.md" },
				],
			});

			expect(countOccurrences(prompt, "Use static imports.")).toBe(1);
			expect(countOccurrences(prompt, "Do not use dynamic loading.")).toBe(1);
			expect(countOccurrences(prompt, distinctRule)).toBe(1);
		});
	});

	test("buildSystemPrompt deduplicates always-apply rules already present in customPrompt", async () => {
		const duplicateRule = ["Keep functions small.", "", "Extract shared helpers on the second use."].join("\n");
		const distinctRule = "Surface failures explicitly to callers.";

		const prompt = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			customPrompt: ["Custom guidance", "", duplicateRule, "", "More custom guidance"].join("\n"),
			alwaysApplyRules: [
				{ name: "small-functions", content: duplicateRule, path: "/tmp/small-functions.md" },
				{ name: "truthful-failures", content: distinctRule, path: "/tmp/truthful-failures.md" },
			],
		});

		expect(countOccurrences(prompt, "Keep functions small.")).toBe(1);
		expect(countOccurrences(prompt, "Extract shared helpers on the second use.")).toBe(1);
		expect(countOccurrences(prompt, distinctRule)).toBe(1);
	});

	test("buildSystemPrompt omits CPU info when os.cpus fails", async () => {
		vi.spyOn(os, "cpus").mockImplementation(() => {
			throw new Error("os.cpus() failed");
		});

		const systemPrompt = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
		});

		const workstation = /<workstation>\n(?<content>[\s\S]*?)\n<\/workstation>/u.exec(systemPrompt)?.groups?.content;
		expect(workstation).toContain("OS:");
		expect(workstation).not.toContain("CPU:");
	});
});
