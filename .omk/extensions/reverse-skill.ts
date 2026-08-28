import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { StringEnum } from "omk-ai";
import { Type } from "typebox";
import {
	defineTool,
	formatReverseSkillFromSource,
	formatReverseSkillMarkdown,
	formatReverseSkillRouteDecision,
	getReverseSkillToolAliases,
	normalizeReverseSkillName,
	planReverseSkillToolChecks,
	routeReverseSkill,
	type ExecResult,
	type ExtensionAPI,
	type ReverseSkillPlatform,
	withFileMutationQueue,
} from "open-multi-agent-kit";

interface ToolStatus {
	tool: string;
	commands: string[];
	available: boolean;
	command?: string;
	version?: string;
	error?: string;
}

function firstLine(result: ExecResult): string | undefined {
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}

async function checkTool(omk: ExtensionAPI, tool: string): Promise<ToolStatus> {
	const commands = getReverseSkillToolAliases(tool);
	for (const command of commands) {
		try {
			const result = await omk.exec(command, ["--version"], { timeout: 3000 });
			const version = firstLine(result);
			if (result.code === 0 || version) {
				return { tool, commands, available: true, command, version };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "tool check failed";
			if (command === commands.at(-1)) return { tool, commands, available: false, error: message };
		}
	}
	return { tool, commands, available: false, error: "command not found or did not return version output" };
}

function formatToolStatuses(statuses: ToolStatus[]): string {
	if (statuses.length === 0) return "No tool checks requested.";
	return statuses
		.map((status) => {
			if (status.available) {
				const suffix = status.version ? ` — ${status.version}` : "";
				return `- ${status.tool}: yes (${status.command})${suffix}`;
			}
			return `- ${status.tool}: no (${status.commands.join(" | ")})${status.error ? ` — ${status.error}` : ""}`;
		})
		.join("\n");
}

function resolveProjectOutputPath(cwd: string, path: string): string {
	const cleaned = path.startsWith("@") ? path.slice(1) : path;
	const absolutePath = resolve(cwd, cleaned);
	const relativePath = relative(cwd, absolutePath);
	if (relativePath === "" || relativePath.startsWith("..")) {
		throw new Error(`Output path must stay inside project: ${path}`);
	}
	return absolutePath;
}

const RouteParams = Type.Object({
	query: Type.String({ description: "Task text, issue text, or target description to route" }),
	targetType: Type.Optional(Type.String({ description: "Optional explicit target type, e.g. apk, binary, javascript" })),
	intent: Type.Optional(Type.String({ description: "Optional explicit user intent, e.g. decompile, signature recovery" })),
	toolchain: Type.Optional(Type.String({ description: "Optional explicit toolchain hints, e.g. jadx, IDA, Playwright" })),
	platform: Type.Optional(
		StringEnum(["windows", "linux", "macos", "kali", "unknown"] as const, {
			description: "Optional platform hint",
		}),
	),
	includeToolStatus: Type.Optional(Type.Boolean({ description: "Check selected local tool availability", default: false })),
});

const CreateParams = Type.Object({
	name: Type.String({ description: "Skill name or title. It will be normalized to Agent Skills naming rules." }),
	triggerSummary: Type.String({ description: "When this generated skill should trigger" }),
	description: Type.Optional(Type.String({ description: "Optional frontmatter description" })),
	routeIds: Type.Optional(Type.Array(Type.String(), { description: "Built-in reverse route ids to include" })),
	workflowSteps: Type.Optional(Type.Array(Type.String(), { description: "Ordered workflow steps" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool names to mention" })),
	mcpServers: Type.Optional(Type.Array(Type.String(), { description: "MCP servers or surfaces to mention" })),
	hooks: Type.Optional(Type.Array(Type.String(), { description: "Hooks to mention" })),
	acceptance: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria" })),
	references: Type.Optional(Type.Array(Type.String(), { description: "Reference file paths or URLs" })),
	outputPath: Type.Optional(Type.String({ description: "Project-relative output path. Defaults to .omk/skills/<name>/SKILL.md" })),
});

const CreateFromSourceParams = Type.Object({
	sourceText: Type.String({ description: "Markdown or notes to reverse-engineer into an Agent Skill" }),
	name: Type.Optional(Type.String({ description: "Optional generated skill name" })),
	description: Type.Optional(Type.String({ description: "Optional frontmatter description" })),
	triggerSummary: Type.Optional(Type.String({ description: "Optional trigger summary" })),
	outputPath: Type.Optional(Type.String({ description: "Project-relative output path. Defaults to .omk/skills/<name>/SKILL.md" })),
});

export default function reverseSkillExtension(omk: ExtensionAPI) {
	omk.registerTool(
		defineTool({
			name: "reverse_skill_route",
			label: "Reverse Skill Route",
			description: "Route reverse-engineering, CTF, browser-analysis, API-security, and report-generation tasks to the most specific OMK skill workflow.",
			promptSnippet: "Route reverse-engineering/security tasks by target, intent, toolchain, skills, MCP hints, hooks, and acceptance criteria.",
			promptGuidelines: [
				"Use reverse_skill_route before choosing specialized reverse-engineering, CTF, browser-analysis, or security-review tooling.",
			],
			parameters: RouteParams,
			async execute(_toolCallId, params) {
				const decision = routeReverseSkill({
					query: params.query,
					targetType: params.targetType,
					intent: params.intent,
					toolchain: params.toolchain,
					platform: params.platform as ReverseSkillPlatform | undefined,
				});
				let text = formatReverseSkillRouteDecision(decision);
				let toolStatus: ToolStatus[] = [];
				if (params.includeToolStatus) {
					const tools = planReverseSkillToolChecks(decision);
					toolStatus = await Promise.all(tools.map((tool) => checkTool(omk, tool)));
					text += `\n\n## Tool status\n\n${formatToolStatuses(toolStatus)}`;
				}
				return {
					content: [{ type: "text", text }],
					details: { decision, toolStatus },
				};
			},
		}),
	);

	omk.registerTool(
		defineTool({
			name: "reverse_skill_create",
			label: "Create Reverse Skill",
			description: "Create a project-local OMK Agent Skill from route ids, workflow steps, tool hints, MCP hints, hooks, and acceptance criteria.",
			promptSnippet: "Create project-local OMK skills for reverse-skill routing workflows.",
			promptGuidelines: [
				"Use reverse_skill_create when the user asks to create a reusable OMK skill for a reverse-skill or security-routing workflow.",
			],
			parameters: CreateParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const skillName = normalizeReverseSkillName(params.name);
				const outputPath = resolveProjectOutputPath(
					ctx.cwd,
					params.outputPath ?? `.omk/skills/${skillName}/SKILL.md`,
				);
				const markdown = formatReverseSkillMarkdown({
					name: skillName,
					description: params.description,
					triggerSummary: params.triggerSummary,
					routeIds: params.routeIds,
					workflowSteps: params.workflowSteps,
					tools: params.tools,
					mcpServers: params.mcpServers,
					hooks: params.hooks,
					acceptance: params.acceptance,
					references: params.references,
				});
				await withFileMutationQueue(outputPath, async () => {
					await mkdir(dirname(outputPath), { recursive: true });
					await writeFile(outputPath, markdown, "utf8");
				});
				return {
					content: [{ type: "text", text: `Wrote ${relative(ctx.cwd, outputPath)}` }],
					details: { path: outputPath, skillName },
				};
			},
		}),
	);

	omk.registerTool(
		defineTool({
			name: "reverse_skill_from_source",
			label: "Reverse Skill From Source",
			description: "Reverse-engineer markdown or notes into a project-local OMK Agent Skill with normalized frontmatter and routing-aware workflow defaults.",
			promptSnippet: "Convert source docs or notes into an OMK Agent Skill skeleton.",
			promptGuidelines: [
				"Use reverse_skill_from_source when adapting an external skill pack or markdown playbook into OMK skill format.",
			],
			parameters: CreateFromSourceParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fallbackName = params.name ?? "reverse-skill-workflow";
				const skillName = normalizeReverseSkillName(fallbackName);
				const outputPath = resolveProjectOutputPath(
					ctx.cwd,
					params.outputPath ?? `.omk/skills/${skillName}/SKILL.md`,
				);
				const markdown = formatReverseSkillFromSource({
					sourceText: params.sourceText,
					name: skillName,
					description: params.description,
					triggerSummary: params.triggerSummary,
				});
				await withFileMutationQueue(outputPath, async () => {
					await mkdir(dirname(outputPath), { recursive: true });
					await writeFile(outputPath, markdown, "utf8");
				});
				return {
					content: [{ type: "text", text: `Wrote ${relative(ctx.cwd, outputPath)}` }],
					details: { path: outputPath, skillName },
				};
			},
		}),
	);

	omk.registerCommand("reverse-skill", {
		description: "Route a reverse-skill/security task and show the selected skill workflow",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /reverse-skill <task>", "warning");
				return;
			}
			const decision = routeReverseSkill({ query });
			const text = formatReverseSkillRouteDecision(decision);
			if (ctx.hasUI) ctx.ui.notify(decision.primary ? `reverse-skill: ${decision.primary.route.id}` : "reverse-skill: no route", "info");
			omk.sendMessage({ customType: "reverse-skill", content: text, display: true, details: { decision } });
		},
	});
}
