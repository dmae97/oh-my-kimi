/**
 * GitHub Copilot Provider
 *
 * Loads configuration from GitHub Copilot's config directories.
 * Priority: 30 (shared standard provider)
 *
 * Sources:
 * - Project: .github/ (repo-local Copilot config)
 * - User: ~/.copilot/ (user-global Copilot CLI config; relocatable via COPILOT_HOME)
 * - Extra: directories listed in COPILOT_CUSTOM_INSTRUCTIONS_DIRS
 *
 * Capabilities:
 * - context-files: copilot-instructions.md in .github/, ~/.copilot/, and custom dirs
 * - instructions: *.instructions.md in .github/instructions/ and custom dirs (applyTo frontmatter)
 * - prompts: *.prompt.md in .github/prompts/ and ~/.copilot/prompts/
 * - skills: <name>/SKILL.md in .github/skills/ (GitHub Agent Skills layout)
 */
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import { type Instruction, instructionCapability } from "../capability/instruction";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";

import {
	calculateDepth,
	createSourceMeta,
	getProjectPath,
	loadFilesFromDir,
	parseCSV,
	resolveCopilotHome,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "github";
const DISPLAY_NAME = "GitHub Copilot";
const PRIORITY = 30;

// =============================================================================
// Context Files
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	const copilotInstructionsPath = getProjectPath(ctx, "github", "copilot-instructions.md");
	if (copilotInstructionsPath) {
		const content = await readFile(copilotInstructionsPath);
		if (content) {
			const fileDir = path.dirname(copilotInstructionsPath);
			const depth = calculateDepth(ctx.cwd, fileDir, path.sep);

			items.push({
				path: copilotInstructionsPath,
				content,
				level: "project",
				depth,
				_source: createSourceMeta(PROVIDER_ID, copilotInstructionsPath, "project"),
			});
		}
	}

	// User-global instructions (~/.copilot/copilot-instructions.md), applied across all repos.
	const userInstructionsPath = path.join(resolveCopilotHome(ctx.home), "copilot-instructions.md");
	const userContent = await readFile(userInstructionsPath);
	if (userContent) {
		items.push({
			path: userInstructionsPath,
			content: userContent,
			level: "user",
			_source: createSourceMeta(PROVIDER_ID, userInstructionsPath, "user"),
		});
	}

	// Extra dirs from COPILOT_CUSTOM_INSTRUCTIONS_DIRS each contribute a copilot-instructions.md.
	for (const dir of copilotCustomInstructionDirs()) {
		const customPath = path.join(dir, "copilot-instructions.md");
		const customContent = await readFile(customPath);
		if (customContent) {
			items.push({
				path: customPath,
				content: customContent,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, customPath, "user"),
			});
		}
	}
	return { items, warnings };
}

// =============================================================================
// Instructions
// =============================================================================

async function loadInstructions(ctx: LoadContext): Promise<LoadResult<Instruction>> {
	const items: Instruction[] = [];
	const warnings: string[] = [];

	const instructionsDir = getProjectPath(ctx, "github", "instructions");
	if (instructionsDir) {
		const result = await loadFilesFromDir<Instruction>(ctx, instructionsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: transformInstruction,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Extra dirs from COPILOT_CUSTOM_INSTRUCTIONS_DIRS each contribute *.instructions.md.
	for (const dir of copilotCustomInstructionDirs()) {
		const result = await loadFilesFromDir<Instruction>(ctx, dir, PROVIDER_ID, "user", {
			extensions: ["md"],
			transform: transformInstruction,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function transformInstruction(name: string, content: string, filePath: string, source: SourceMeta): Instruction | null {
	// Only process .instructions.md files
	if (!name.endsWith(".instructions.md")) {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });

	// Extract applyTo glob pattern from frontmatter
	const applyTo = typeof frontmatter.applyTo === "string" ? frontmatter.applyTo : undefined;

	// Derive name from filename (strip .instructions.md suffix)
	const instructionName = path.basename(name, ".instructions.md");

	return {
		name: instructionName,
		path: filePath,
		content: body,
		applyTo,
		_source: source,
	};
}

// =============================================================================
// Prompts
// =============================================================================

async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const projectPromptsDir = getProjectPath(ctx, "github", "prompts");
	const userPromptsDir = path.join(resolveCopilotHome(ctx.home), "prompts");

	const dirs: Array<{ dir: string; level: "user" | "project" }> = [];
	if (projectPromptsDir) dirs.push({ dir: projectPromptsDir, level: "project" });
	dirs.push({ dir: userPromptsDir, level: "user" });

	const results = await Promise.all(
		dirs.map(({ dir, level }) =>
			loadFilesFromDir<Prompt>(ctx, dir, PROVIDER_ID, level, {
				extensions: ["md"],
				transform: transformPrompt,
			}),
		),
	);

	return { items: results.flatMap(r => r.items), warnings: results.flatMap(r => r.warnings ?? []) };
}

function transformPrompt(name: string, content: string, filePath: string, source: SourceMeta): Prompt | null {
	// Copilot prompt files are `*.prompt.md`; ignore other markdown that may share the dir.
	if (!name.endsWith(".prompt.md")) return null;

	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
	const promptName =
		typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : path.basename(name, ".prompt.md");

	return { name: promptName, path: filePath, content: body, _source: source };
}

/** Directories listed in the COPILOT_CUSTOM_INSTRUCTIONS_DIRS env var (comma-separated). */
function copilotCustomInstructionDirs(): string[] {
	const raw = process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
	return raw ? parseCSV(raw) : [];
}

// =============================================================================
// Skills
// =============================================================================

/**
 * Load skills from `.github/skills/<name>/SKILL.md`.
 *
 * GitHub documents this layout for Copilot Agent Skills and matches the
 * non-recursive shape `scanSkillsFromDir` already expects. `requireDescription`
 * is on to match the Agent Skills spec (name + description are mandatory) and
 * the sibling `native`/`omp-plugins` providers.
 *
 * @see https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills
 */
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const skillsDir = getProjectPath(ctx, "github", "skills");
	if (!skillsDir) return { items: [], warnings: [] };

	return scanSkillsFromDir(ctx, {
		dir: skillsDir,
		providerId: PROVIDER_ID,
		level: "project",
		requireDescription: true,
	});
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load copilot-instructions.md from .github/, ~/.copilot/, and COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider(instructionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.instructions.md from .github/instructions/ and COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
	priority: PRIORITY,
	load: loadInstructions,
});

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from .github/skills/*/SKILL.md",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.prompt.md from .github/prompts/ and ~/.copilot/prompts/",
	priority: PRIORITY,
	load: loadPrompts,
});
