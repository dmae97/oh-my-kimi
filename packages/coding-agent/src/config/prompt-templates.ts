import * as fs from "node:fs";
import * as path from "node:path";
import { type ChunkAnchorStyle, formatAnchor } from "@oh-my-pi/pi-natives";
import {
	getProjectDir,
	getProjectPromptsDir,
	getPromptsDir,
	logger,
	parseFrontmatter,
	prompt,
} from "@oh-my-pi/pi-utils";
import { computeLineHash, HASHLINE_CONTENT_SEPARATOR } from "../edit/line-hash";
import { jtdToTypeScript } from "../tools/jtd-to-typescript";
import { parseCommandArgs, substituteArgs } from "../utils/command-args";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	source: string; // e.g., "(user)", "(project)", "(project:frontend)"
}

prompt.registerHelper("jtdToTypeScript", (schema: unknown): string => {
	try {
		return jtdToTypeScript(schema);
	} catch {
		return "unknown";
	}
});

// `sectionSeparator` + SECTION_SEPARATOR helper live in pi-utils/prompt so every
// template consumer gets them registered without a coupling back to this module.
// Re-exported here for call sites that already reference the coding-agent path.
export { sectionSeparator } from "@oh-my-pi/pi-utils/prompt";

function formatHashlineRef(lineNum: unknown, content: unknown): { num: number; text: string; ref: string } {
	const num = typeof lineNum === "number" ? lineNum : Number.parseInt(String(lineNum), 10);
	const raw = typeof content === "string" ? content : String(content ?? "");
	const text = raw.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\r/g, "\r");
	const ref = `${num}${computeLineHash(num, text)}`;
	return { num, text, ref };
}

/**
 * {{href lineNum "content"}} — compute a real hashline ref for prompt examples.
 * Returns `"lineNumBIGRAM"` (e.g., `"42nd"`) using the actual hash algorithm.
 */
prompt.registerHelper("href", (lineNum: unknown, content: unknown): string => {
	const { ref } = formatHashlineRef(lineNum, content);
	return JSON.stringify(ref);
});

/**
 * {{hline lineNum "content"}} — format a full read-style line with prefix.
 * Returns `"lineNumBIGRAM|content"` (pipe between anchor and content).
 */
prompt.registerHelper("hline", (lineNum: unknown, content: unknown): string => {
	const { ref, text } = formatHashlineRef(lineNum, content);
	return `${ref}${HASHLINE_CONTENT_SEPARATOR}${text}`;
});

/**
 * {{anchor name checksum}} — render a branch anchor tag using the current anchor style.
 * Style is resolved from the template context (`anchorStyle`) or defaults to "full".
 */
prompt.registerHelper("anchor", function (this: prompt.TemplateContext, name: string, checksum: string): string {
	const style = (this.anchorStyle as ChunkAnchorStyle) ?? "full";
	return formatAnchor(name, checksum, style);
});

/**
 * {{sel "parent_Name.child_Name"}} — render a chunk path for `sel` fields in examples.
 * In `full` style the path is returned as-is (`class_Server.fn_start`).
 * In `kind` style each segment is trimmed to its kind prefix (`class.fn`).
 * In `bare` style the path is omitted (the model uses only `crc` to identify chunks).
 */
prompt.registerHelper("sel", function (this: prompt.TemplateContext, chunkPath: string): string {
	const style = (this.anchorStyle as ChunkAnchorStyle) ?? "full";
	if (style === "full") return chunkPath;
	if (style === "bare") return "";
	// kind: trim each segment to its kind prefix (before the first `_`)
	return chunkPath
		.split(".")
		.map(seg => {
			const idx = seg.indexOf("_");
			return idx === -1 ? seg : seg.slice(0, idx);
		})
		.join(".");
});

const INLINE_ARG_SHELL_PATTERN = /\$(?:ARGUMENTS|@(?:\[\d+(?::\d*)?\])?|\d+)/;
const INLINE_ARG_TEMPLATE_PATTERN = /\{\{[\s\S]*?(?:\b(?:arguments|ARGUMENTS|args)\b|\barg\s+[^}]+)[\s\S]*?\}\}/;

/**
 * Keep the check source-level and cheap: if the template text contains any explicit
 * inline-arg placeholder syntax, do not append the fallback text again.
 */
export function templateUsesInlineArgPlaceholders(templateSource: string): boolean {
	return INLINE_ARG_SHELL_PATTERN.test(templateSource) || INLINE_ARG_TEMPLATE_PATTERN.test(templateSource);
}

export function appendInlineArgsFallback(
	rendered: string,
	argsText: string,
	usesInlineArgPlaceholders: boolean,
): string {
	if (argsText.length === 0 || usesInlineArgPlaceholders) return rendered;
	if (rendered.length === 0) return argsText;

	return `${rendered}\n\n${argsText}`;
}

/**
 * Recursively scan a directory for .md files (and symlinks to .md files) and load them as prompt templates
 */
async function loadTemplatesFromDir(
	dir: string,
	source: "user" | "project",
	subdir: string = "",
): Promise<PromptTemplate[]> {
	const templates: PromptTemplate[] = [];
	try {
		const glob = new Bun.Glob("**/*");
		const entries = [];
		for await (const entry of glob.scan({ cwd: dir, absolute: false, onlyFiles: false })) {
			entries.push(entry);
		}

		// Group by path depth to process directories before deeply nested files
		entries.sort((a, b) => a.split("/").length - b.split("/").length);

		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			const file = Bun.file(fullPath);

			try {
				const stat = await file.exists();
				if (!stat) continue;

				if (entry.endsWith(".md")) {
					const rawContent = await file.text();
					const { frontmatter, body } = parseFrontmatter(rawContent, { source: fullPath });

					const name = entry.split("/").pop()!.slice(0, -3); // Remove .md extension

					// Build source string based on subdirectory structure
					const entryDir = entry.includes("/") ? entry.split("/").slice(0, -1).join(":") : "";
					const fullSubdir = subdir && entryDir ? `${subdir}:${entryDir}` : entryDir || subdir;

					let sourceStr: string;
					if (source === "user") {
						sourceStr = fullSubdir ? `(user:${fullSubdir})` : "(user)";
					} else {
						sourceStr = fullSubdir ? `(project:${fullSubdir})` : "(project)";
					}

					// Get description from frontmatter or first non-empty line
					let description = String(frontmatter.description || "");
					if (!description) {
						const firstLine = body.split("\n").find(line => line.trim());
						if (firstLine) {
							// Truncate if too long
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) description += "...";
						}
					}

					// Append source to description
					description = description ? `${description} ${sourceStr}` : sourceStr;

					templates.push({
						name,
						description,
						content: body,
						source: sourceStr,
					});
				}
			} catch (error) {
				logger.warn("Failed to load prompt template", { path: fullPath, error: String(error) });
			}
		}
	} catch (error) {
		if (!fs.existsSync(dir)) {
			return [];
		}
		logger.warn("Failed to scan prompt templates directory", { dir, error: String(error) });
	}

	return templates;
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory for global templates. Default: from getPromptsDir() */
	agentDir?: string;
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/.omp/prompts/
 */
export async function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): Promise<PromptTemplate[]> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const resolvedAgentDir = options.agentDir ?? getPromptsDir();

	const templates: PromptTemplate[] = [];

	// 1. Load global templates from agentDir/prompts/
	// Note: if agentDir is provided, it should be the agent dir, not the prompts dir
	const globalPromptsDir = options.agentDir ? path.join(options.agentDir, "prompts") : resolvedAgentDir;
	templates.push(...(await loadTemplatesFromDir(globalPromptsDir, "user")));

	// 2. Load project templates from cwd/.omp/prompts/
	const projectPromptsDir = getProjectPromptsDir(resolvedCwd);
	templates.push(...(await loadTemplatesFromDir(projectPromptsDir, "project")));

	return templates;
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const template = templates.find(t => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		const argsText = args.join(" ");
		const usesInlineArgPlaceholders = templateUsesInlineArgPlaceholders(template.content);
		const substituted = substituteArgs(template.content, args);
		const rendered = prompt.render(substituted, { args, ARGUMENTS: argsText, arguments: argsText });
		return appendInlineArgsFallback(rendered, argsText, usesInlineArgPlaceholders);
	}

	return text;
}
