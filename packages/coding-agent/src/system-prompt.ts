/**
 * System prompt construction and project context loading
 */

import * as os from "node:os";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import { $env, getGpuCachePath, getProjectDir, hasFsCode, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { contextFileCapability } from "./capability/context-file";
import { systemPromptCapability } from "./capability/system-prompt";
import type { SkillsSettings } from "./config/settings";
import { type ContextFile, loadCapability, type SystemPrompt as SystemPromptFile } from "./discovery";
import { loadSkills, type Skill } from "./extensibility/skills";
import customSystemPromptTemplate from "./prompts/system/custom-system-prompt.md" with { type: "text" };
import projectPromptTemplate from "./prompts/system/project-prompt.md" with { type: "text" };
import systemPromptTemplate from "./prompts/system/system-prompt.md" with { type: "text" };
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

interface AlwaysApplyRule {
	name: string;
	content: string;
	path: string;
}

function normalizePromptBlock(content: string): string {
	return prompt.format(content, { renderPhase: "post-render" }).trim();
}

function splitComparablePromptBlocks(content: string | null | undefined): string[] {
	const normalized = firstNonEmpty(content);
	if (!normalized) return [];

	return normalizePromptBlock(normalized)
		.split(/\n{2,}/)
		.map(block => block.trim())
		.filter(block => block.length > 0);
}

function promptSourceContainsRule(source: string | null | undefined, ruleContent: string): boolean {
	const sourceBlocks = splitComparablePromptBlocks(source);
	const ruleBlocks = splitComparablePromptBlocks(ruleContent);
	if (sourceBlocks.length === 0 || ruleBlocks.length === 0 || ruleBlocks.length > sourceBlocks.length) return false;

	for (let start = 0; start <= sourceBlocks.length - ruleBlocks.length; start += 1) {
		if (ruleBlocks.every((block, offset) => sourceBlocks[start + offset] === block)) return true;
	}

	return false;
}

function dedupeAlwaysApplyRules(
	alwaysApplyRules: AlwaysApplyRule[] | undefined,
	promptSources: Array<string | null | undefined>,
): AlwaysApplyRule[] {
	if (!alwaysApplyRules || alwaysApplyRules.length === 0) return [];

	return alwaysApplyRules.filter(
		rule => !promptSources.some(source => promptSourceContainsRule(source, rule.content)),
	);
}

function dedupePromptSource(source: string | null | undefined, otherSources: Array<string | null | undefined>): string {
	const resolvedSource = firstNonEmpty(source);
	if (!resolvedSource) return "";

	return otherSources.some(otherSource => promptSourceContainsRule(otherSource, resolvedSource)) ? "" : resolvedSource;
}

function firstNonEmpty(...values: (string | undefined | null)[]): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function parseWmicTable(output: string, header: string): string | null {
	const lines = output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	const filtered = lines.filter(line => line.toLowerCase() !== header.toLowerCase());
	return filtered[0] ?? null;
}

const AGENTS_MD_MIN_DEPTH = 1;
const AGENTS_MD_MAX_DEPTH = 4;
const AGENTS_MD_LIMIT = 200;
const SYSTEM_PROMPT_PREP_TIMEOUT_MS = 5000;
const AGENTS_MD_EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

export interface AgentsMdSearch {
	scopePath: string;
	limit: number;
	pattern: string;
	files: string[];
}

async function listAgentsMdFiles(root: string, limit: number): Promise<string[]> {
	try {
		const result = await glob({
			pattern: "**/AGENTS.md",
			path: root,
			fileType: FileType.File,
			recursive: true,
			hidden: false,
			gitignore: true,
			maxResults: limit * 4,
			cache: true,
		});
		const files: string[] = [];
		for (const m of result.matches) {
			const rel = m.path.replace(/\\/g, "/");
			if (!rel?.endsWith("AGENTS.md")) continue;
			const segments = rel.split("/");
			const depth = segments.length - 1;
			if (depth < AGENTS_MD_MIN_DEPTH || depth > AGENTS_MD_MAX_DEPTH) continue;
			const dirSegments = segments.slice(0, -1);
			if (dirSegments.some(seg => AGENTS_MD_EXCLUDED_DIRS.has(seg) || seg.startsWith("."))) continue;
			files.push(rel);
			if (files.length >= limit) break;
		}
		return Array.from(new Set(files)).sort().slice(0, limit);
	} catch {
		return [];
	}
}

export async function buildAgentsMdSearch(cwd: string): Promise<AgentsMdSearch> {
	const files = await listAgentsMdFiles(cwd, AGENTS_MD_LIMIT);
	return {
		scopePath: ".",
		limit: AGENTS_MD_LIMIT,
		pattern: `AGENTS.md depth ${AGENTS_MD_MIN_DEPTH}-${AGENTS_MD_MAX_DEPTH}`,
		files,
	};
}

async function getGpuModel(): Promise<string | null> {
	switch (process.platform) {
		case "win32": {
			const output = await $`wmic path win32_VideoController get name`
				.quiet()
				.text()
				.catch(() => null);
			return output ? parseWmicTable(output, "Name") : null;
		}
		case "linux": {
			const output = await $`lspci`
				.quiet()
				.text()
				.catch(() => null);
			if (!output) return null;
			const gpus: Array<{ name: string; priority: number }> = [];
			for (const line of output.split("\n")) {
				if (!/(VGA|3D|Display)/i.test(line)) continue;
				const parts = line.split(":");
				const name = parts.length > 1 ? parts.slice(1).join(":").trim() : line.trim();
				const nameLower = name.toLowerCase();
				// Skip BMC/server management adapters
				if (/aspeed|matrox g200|mgag200/i.test(name)) continue;
				// Prioritize discrete GPUs
				let priority = 0;
				if (
					nameLower.includes("nvidia") ||
					nameLower.includes("geforce") ||
					nameLower.includes("quadro") ||
					nameLower.includes("rtx")
				) {
					priority = 3;
				} else if (nameLower.includes("amd") || nameLower.includes("radeon") || nameLower.includes("rx ")) {
					priority = 3;
				} else if (nameLower.includes("intel")) {
					priority = 1;
				} else {
					priority = 2;
				}
				gpus.push({ name, priority });
			}
			if (gpus.length === 0) return null;
			gpus.sort((a, b) => b.priority - a.priority);
			return gpus[0].name;
		}
		default:
			return null;
	}
}

function getTerminalName(): string | undefined {
	const termProgram = Bun.env.TERM_PROGRAM;
	const termProgramVersion = Bun.env.TERM_PROGRAM_VERSION;
	if (termProgram) {
		return termProgramVersion ? `${termProgram} ${termProgramVersion}` : termProgram;
	}

	if (Bun.env.WT_SESSION) return "Windows Terminal";

	const term = firstNonEmpty(Bun.env.TERM, Bun.env.COLORTERM, Bun.env.TERMINAL_EMULATOR);
	return term ?? undefined;
}

/** Cached system info structure */
interface GpuCache {
	gpu: string;
}

function getSystemInfoCachePath(): string {
	return getGpuCachePath();
}

async function loadGpuCache(): Promise<GpuCache | null> {
	try {
		const cachePath = getSystemInfoCachePath();
		const content = await Bun.file(cachePath).json();
		return content as GpuCache;
	} catch {
		return null;
	}
}

async function saveGpuCache(info: GpuCache): Promise<void> {
	try {
		const cachePath = getSystemInfoCachePath();
		await Bun.write(cachePath, JSON.stringify(info, null, "\t"));
	} catch {
		// Silently ignore cache write failures
	}
}

async function getCachedGpu(): Promise<string | undefined> {
	const cached = await logger.time("getCachedGpu:loadGpuCache", loadGpuCache);
	if (cached) return cached.gpu;
	const gpu = await logger.time("getCachedGpu:getGpuModel", getGpuModel);
	if (gpu) {
		await logger.time("getCachedGpu:saveGpuCache", saveGpuCache, { gpu });
	}
	return gpu ?? undefined;
}
async function getEnvironmentInfo(): Promise<Array<{ label: string; value: string }>> {
	const gpu = await getCachedGpu();
	let cpuModel: string | undefined;
	try {
		cpuModel = os.cpus()[0]?.model;
	} catch {
		cpuModel = undefined;
	}
	const entries: Array<{ label: string; value: string | undefined }> = [
		{ label: "OS", value: `${os.platform()} ${os.release()}` },
		{ label: "Distro", value: os.type() },
		{ label: "Kernel", value: os.version() },
		{ label: "Arch", value: os.arch() },
		{ label: "CPU", value: cpuModel },
		{ label: "GPU", value: gpu },
		{ label: "Terminal", value: getTerminalName() },
	];
	return entries.filter((e): e is { label: string; value: string } => !!e.value);
}

/** Resolve input as file path or literal string */
export async function resolvePromptInput(input: string | undefined, description: string): Promise<string | undefined> {
	if (!input) {
		return undefined;
	} else if (input.includes("\n")) {
		return input;
	}

	try {
		return await Bun.file(input).text();
	} catch (error) {
		if (!hasFsCode(error, "ENAMETOOLONG") && !isEnoent(error)) {
			logger.warn(`Could not read ${description} file`, { path: input, error: String(error) });
		}
		return input;
	}
}

export interface LoadContextFilesOptions {
	/** Working directory to start walking up from. Default: getProjectDir() */
	cwd?: string;
}

function dedupeExactContextFiles(
	contextFiles: Array<{ path: string; content: string; depth?: number }>,
): Array<{ path: string; content: string; depth?: number }> {
	const lastIndexByContent = new Map<string, number>();
	for (const [index, file] of contextFiles.entries()) {
		// Keep the closest matching context entry when content is byte-for-byte identical.
		lastIndexByContent.set(file.content, index);
	}

	return contextFiles.filter((file, index) => lastIndexByContent.get(file.content) === index);
}

/**
 * Load all project context files using the capability API.
 * Returns {path, content, depth} entries for all discovered context files.
 * Files are sorted by depth (descending) so files closer to cwd appear last/more prominent.
 */
export async function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability(contextFileCapability.id, { cwd: resolvedCwd });

	// Convert ContextFile items and preserve depth info
	const files = result.items.map(item => {
		const contextFile = item as ContextFile;
		return {
			path: contextFile.path,
			content: contextFile.content,
			depth: contextFile.depth,
		};
	});

	// Sort by depth (descending): higher depth (farther from cwd) comes first,
	// so files closer to cwd appear later and are more prominent
	files.sort((a, b) => {
		const depthA = a.depth ?? -1;
		const depthB = b.depth ?? -1;
		return depthB - depthA;
	});

	return dedupeExactContextFiles(files);
}

/**
 * Load the effective system prompt customization from SYSTEM.md.
 * Project-level SYSTEM.md overrides user-level SYSTEM.md.
 */
export async function loadSystemPromptFiles(options: LoadContextFilesOptions = {}): Promise<string | null> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability<SystemPromptFile>(systemPromptCapability.id, { cwd: resolvedCwd });

	if (result.items.length === 0) return null;

	const projectLevel = result.items.find(item => item.level === "project");
	if (projectLevel) {
		return projectLevel.content;
	}

	const userLevel = result.items.find(item => item.level === "user");
	return userLevel?.content ?? null;
}

export interface SystemPromptToolMetadata {
	label: string;
	description: string;
	/** Tool name the model sees on the provider wire. Defaults to the internal tool name. */
	wireName?: string;
}

export function buildSystemPromptToolMetadata(
	tools: Map<string, AgentTool>,
	overrides: Partial<Record<string, Partial<SystemPromptToolMetadata>>> = {},
): Map<string, SystemPromptToolMetadata> {
	return new Map(
		Array.from(tools.entries(), ([name, tool]) => {
			const toolRecord = tool as AgentTool & { label?: string; description?: string };
			const override = overrides[name];
			const wireName =
				override?.wireName ??
				(typeof toolRecord.customWireName === "string" ? toolRecord.customWireName : undefined);
			return [
				name,
				{
					label: override?.label ?? (typeof toolRecord.label === "string" ? toolRecord.label : ""),
					description:
						override?.description ?? (typeof toolRecord.description === "string" ? toolRecord.description : ""),
					wireName,
				},
			] as const;
		}),
	);
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. */
	tools?: Map<string, SystemPromptToolMetadata>;
	/** Tool names to include in prompt. */
	toolNames?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Repeat full tool descriptions in system prompt. Default: false */
	repeatToolDescriptions?: boolean;
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Working directory. Default: getProjectDir() */
	cwd?: string;
	/** Pre-loaded context files (skips discovery if provided). */
	contextFiles?: Array<{ path: string; content: string; depth?: number }>;
	/** Skills provided directly to system prompt construction. */
	skills?: Skill[];
	/** Pre-loaded rulebook rules (descriptions, excluding TTSR and always-apply). */
	rules?: Array<{ name: string; description?: string; path: string; globs?: string[] }>;
	/** Intent field name injected into every tool schema. If set, explains the field in the prompt. */
	intentField?: string;
	/** Whether MCP tool discovery is active for this prompt build. */
	mcpDiscoveryMode?: boolean;
	/** Discoverable MCP server summaries to advertise when discovery mode is active. */
	mcpDiscoveryServerSummaries?: string[];
	/** Encourage the agent to delegate via tasks unless changes are trivial. */
	eagerTasks?: boolean;
	/** Rules with alwaysApply=true — their full content is injected into the prompt. */
	alwaysApplyRules?: AlwaysApplyRule[];
	/** Whether secret obfuscation is active. When true, explains the redaction format in the prompt. */
	secretsEnabled?: boolean;
	/** Pre-loaded AGENTS.md search (skips discovery if provided). May be a Promise to allow early kick-off. */
	agentsMdSearch?: AgentsMdSearch | Promise<AgentsMdSearch>;
	/** Pre-loaded workspace tree (skips discovery if provided). May be a Promise to allow early kick-off. */
	workspaceTree?: WorkspaceTree | Promise<WorkspaceTree>;
}

/** Result of building provider-facing system prompt messages. */
export interface BuildSystemPromptResult {
	/** Ordered system prompt blocks. Providers should preserve entries as distinct messages/blocks. */
	systemPrompt: string[];
}

/** Build the system prompt with tools, guidelines, and context */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	if ($env.NULL_PROMPT === "true") {
		return { systemPrompt: [] };
	}

	const {
		customPrompt,
		tools,
		appendSystemPrompt,
		repeatToolDescriptions = false,
		skillsSettings,
		toolNames: providedToolNames,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		rules,
		alwaysApplyRules,
		intentField,
		mcpDiscoveryMode = false,
		mcpDiscoveryServerSummaries = [],
		eagerTasks = false,
		secretsEnabled = false,
		agentsMdSearch: providedAgentsMdSearch,
		workspaceTree: providedWorkspaceTree,
	} = options;
	const resolvedCwd = cwd ?? getProjectDir();

	const prepPromise = (() => {
		const systemPromptCustomizationPromise = logger.time("loadSystemPromptFiles", loadSystemPromptFiles, {
			cwd: resolvedCwd,
		});
		const contextFilesPromise = providedContextFiles
			? Promise.resolve(providedContextFiles)
			: logger.time("loadProjectContextFiles", loadProjectContextFiles, { cwd: resolvedCwd });
		const agentsMdSearchPromise =
			providedAgentsMdSearch !== undefined
				? Promise.resolve(providedAgentsMdSearch)
				: logger.time("buildAgentsMdSearch", buildAgentsMdSearch, resolvedCwd);
		const workspaceTreePromise =
			providedWorkspaceTree !== undefined
				? Promise.resolve(providedWorkspaceTree)
				: logger.time("buildWorkspaceTree", buildWorkspaceTree, resolvedCwd);
		const skillsPromise: Promise<Skill[]> =
			providedSkills !== undefined
				? Promise.resolve(providedSkills)
				: skillsSettings?.enabled !== false
					? loadSkills({ ...skillsSettings, cwd: resolvedCwd }).then(result => result.skills)
					: Promise.resolve([]);

		return Promise.all([
			resolvePromptInput(customPrompt, "system prompt"),
			resolvePromptInput(appendSystemPrompt, "append system prompt"),
			systemPromptCustomizationPromise,
			contextFilesPromise,
			agentsMdSearchPromise,
			skillsPromise,
			workspaceTreePromise,
		]).then(
			([
				resolvedCustomPrompt,
				resolvedAppendPrompt,
				systemPromptCustomization,
				contextFiles,
				agentsMdSearch,
				skills,
				workspaceTree,
			]) => ({
				resolvedCustomPrompt,
				resolvedAppendPrompt,
				systemPromptCustomization,
				contextFiles,
				agentsMdSearch,
				skills,
				workspaceTree,
			}),
		);
	})();

	const prepResult = await Promise.race([
		prepPromise
			.then(value => ({ type: "ready" as const, value }))
			.catch(error => ({ type: "error" as const, error })),
		Bun.sleep(SYSTEM_PROMPT_PREP_TIMEOUT_MS).then(() => ({ type: "timeout" as const })),
	]);

	let resolvedCustomPrompt: string | undefined;
	let resolvedAppendPrompt: string | undefined;
	let systemPromptCustomization: string | null = null;
	let contextFiles: Array<{ path: string; content: string; depth?: number }> = dedupeExactContextFiles(
		providedContextFiles ?? [],
	);
	let agentsMdSearch: AgentsMdSearch = {
		scopePath: ".",
		limit: AGENTS_MD_LIMIT,
		pattern: `AGENTS.md depth ${AGENTS_MD_MIN_DEPTH}-${AGENTS_MD_MAX_DEPTH}`,
		files: [],
	};
	let workspaceTree: WorkspaceTree = {
		rootPath: resolvedCwd,
		rendered: "",
		truncated: false,
		totalLines: 0,
	};
	let skills: Skill[] = providedSkills ?? [];

	if (prepResult.type === "timeout") {
		logger.warn("System prompt preparation timed out; using minimal startup context", {
			cwd: resolvedCwd,
			timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS,
		});
		process.stderr.write(
			`Warning: system prompt preparation timed out after ${SYSTEM_PROMPT_PREP_TIMEOUT_MS}ms; using minimal startup context.\n`,
		);
	} else if (prepResult.type === "error") {
		logger.warn("System prompt preparation failed; using minimal startup context", {
			cwd: resolvedCwd,
			error: String(prepResult.error),
		});
		process.stderr.write("Warning: system prompt preparation failed; using minimal startup context.\n");
	} else {
		resolvedCustomPrompt = prepResult.value.resolvedCustomPrompt;
		resolvedAppendPrompt = prepResult.value.resolvedAppendPrompt;
		systemPromptCustomization = prepResult.value.systemPromptCustomization;
		contextFiles = dedupeExactContextFiles(prepResult.value.contextFiles);
		agentsMdSearch = prepResult.value.agentsMdSearch;
		skills = prepResult.value.skills;
		workspaceTree = prepResult.value.workspaceTree;
	}

	const date = new Date().toISOString().slice(0, 10);
	const dateTime = date;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	// Build tool metadata for system prompt rendering
	// Priority: explicit list > tools map > defaults
	// Default includes both bash and python; actual availability determined by settings in createTools
	let toolNames = providedToolNames;
	if (!toolNames) {
		if (tools) {
			// Tools map provided
			toolNames = Array.from(tools.keys());
		} else {
			// Use defaults
			toolNames = ["read", "bash", "eval", "edit", "write"]; // TODO: Why?
		}
	}

	// Build tool descriptions for system prompt rendering.
	const toolPromptNames = new Map<string, string>(toolNames.map(name => [name, tools?.get(name)?.wireName ?? name]));
	const toolRefs = Object.fromEntries(toolPromptNames.entries());
	const toolInfo = toolNames.map(name => ({
		name: toolPromptNames.get(name) ?? name,
		internalName: name,
		label: tools?.get(name)?.label ?? "",
		description: tools?.get(name)?.description ?? "",
	}));

	// Filter skills to only include those with read tool.
	const hasRead = tools?.has("read");
	const filteredSkills = hasRead ? skills : [];

	const effectiveSystemPromptCustomization = dedupePromptSource(systemPromptCustomization, [
		resolvedCustomPrompt,
		resolvedAppendPrompt,
	]);
	const promptSources = [effectiveSystemPromptCustomization, resolvedCustomPrompt, resolvedAppendPrompt];
	const injectedAlwaysApplyRules = dedupeAlwaysApplyRules(alwaysApplyRules, promptSources);

	const environment = await logger.time("getEnvironmentInfo", getEnvironmentInfo);
	const reportToolIssueToolName = toolPromptNames.get("report_tool_issue") ?? "report_tool_issue";
	const data = {
		systemPromptCustomization: effectiveSystemPromptCustomization,
		customPrompt: resolvedCustomPrompt,
		appendPrompt: resolvedAppendPrompt ?? "",
		tools: toolNames,
		toolInfo,
		repeatToolDescriptions,
		toolRefs,
		environment,
		contextFiles,
		agentsMdSearch,
		workspaceTree,
		skills: filteredSkills,
		rules: rules ?? [],
		alwaysApplyRules: injectedAlwaysApplyRules,
		date,
		dateTime,
		cwd: promptCwd,
		intentTracing: !!intentField,
		intentField: intentField ?? "",
		mcpDiscoveryMode,
		hasMCPDiscoveryServers: mcpDiscoveryServerSummaries.length > 0,
		mcpDiscoveryServerSummaries,
		eagerTasks,
		secretsEnabled,
	};
	let rendered = prompt.render(resolvedCustomPrompt ? customSystemPromptTemplate : systemPromptTemplate, data);

	// When autoqa is active the report_tool_issue tool is in the tool set — nudge the agent.
	if (toolNames.includes("report_tool_issue")) {
		rendered += `\n\n<critical>\nThe \`${reportToolIssueToolName}\` tool is available for automated QA. If ANY tool you call returns output that is unexpected, incorrect, malformed, or otherwise inconsistent with what you anticipated given the tool's described behavior and your parameters, call \`${reportToolIssueToolName}\` with the tool name and a concise description of the discrepancy. Do not hesitate to report — false positives are acceptable.\n</critical>`;
	}

	const systemPrompt = [rendered];
	const projectPrompt = resolvedCustomPrompt ? "" : prompt.render(projectPromptTemplate, data).trim();
	if (projectPrompt) {
		systemPrompt.push(projectPrompt);
	}

	return { systemPrompt };
}
