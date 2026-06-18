/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@oh-my-pi/pi-coding-agent` (or one of its aliased scopes like
 * `@earendil-works/pi-coding-agent` or `@mariozechner/pi-coding-agent`).
 *
 * The coding-agent package's own barrel (`./src/index.ts`) cannot be listed
 * as a `bun --compile` extra entrypoint alongside the CLI entry without
 * silently breaking the main binary's startup (see issue #1474 follow-up).
 * Routing legacy plugin imports through this sibling shim sidesteps that
 * conflict: bun bundles a distinct entry whose path differs from the CLI
 * entry, while still re-exporting the canonical surface so plugins observe
 * the same module identity as a direct `@oh-my-pi/pi-coding-agent` import.
 */

import type { TSchema } from "@oh-my-pi/pi-ai";
import { parseFrontmatter as parseOmpFrontmatter } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { ToolDefinition } from "./extensions/types";
import { Type } from "./typebox";

export interface ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
	frontmatter: T;
	body: string;
}

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> {
	const { frontmatter, body } = parseOmpFrontmatter(content, { level: "fatal" });
	return { frontmatter: frontmatter as T, body };
}

export function stripFrontmatter(content: string): string {
	return parseFrontmatter(content).body;
}

export function defineTool<TParams extends TSchema = TSchema, TDetails = unknown>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return tool;
}

export function createCodingTools(_cwd: string): ToolDefinition[] {
	return [];
}

export const SettingsManager = {
	create(cwd: string, agentDir?: string): Promise<Settings> {
		return Settings.init({ cwd, agentDir });
	},

	inMemory(): Settings {
		return Settings.isolated();
	},
} as const;

export * from "../index";
export { Type };
