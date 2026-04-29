import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { $which, logger, prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { executeBash } from "../exec/bash-executor";
import justDescription from "../prompts/tools/just.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const justSchema = Type.Object({
	just: Type.String({
		description: 'recipe name and args, e.g. "build" or "test --quiet"',
		examples: ["build", "test --release"],
	}),
});

type JustParams = Static<typeof justSchema>;

interface JustParameterInfo {
	name: string;
}

interface JustRecipeInfo {
	name: string;
	doc?: string;
	parameters: JustParameterInfo[];
}

interface JustDumpRecipeRaw {
	name?: string;
	doc?: string | null;
	private?: boolean;
	parameters?: Array<{ name?: string }>;
}

interface JustDump {
	recipes?: Record<string, JustDumpRecipeRaw>;
}

export interface JustToolDetails {
	meta?: OutputMeta;
	exitCode?: number;
}

const JUSTFILE_NAMES = ["justfile", "Justfile", ".justfile"] as const;

function findJustfileInCwd(cwd: string): string | null {
	for (const name of JUSTFILE_NAMES) {
		const candidate = path.join(cwd, name);
		try {
			const stat = fs.statSync(candidate);
			if (stat.isFile()) return candidate;
		} catch {
			// ignore
		}
	}
	return null;
}

async function dumpRecipes(cwd: string): Promise<JustRecipeInfo[] | null> {
	try {
		const proc = Bun.spawn(["just", "--dump", "--dump-format=json"], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exit !== 0) return null;
		const dump = JSON.parse(stdout) as JustDump;
		const recipes: JustRecipeInfo[] = [];
		for (const recipe of Object.values(dump.recipes ?? {})) {
			if (!recipe.name || recipe.private) continue;
			const params: JustParameterInfo[] = (recipe.parameters ?? [])
				.map(p => p.name)
				.filter((n): n is string => typeof n === "string" && n.length > 0)
				.map(name => ({ name }));
			const doc = typeof recipe.doc === "string" && recipe.doc.length > 0 ? recipe.doc : undefined;
			recipes.push({ name: recipe.name, doc, parameters: params });
		}
		return recipes;
	} catch (err) {
		logger.debug("just --dump failed", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

interface RecipeViewModel {
	name: string;
	paramSig?: string;
	doc?: string;
}

export class JustTool implements AgentTool<typeof justSchema, JustToolDetails> {
	readonly name = "just";
	readonly label = "Just";
	readonly description: string;
	readonly parameters = justSchema;
	readonly strict = true;

	constructor(
		private readonly session: ToolSession,
		recipes: JustRecipeInfo[],
	) {
		const view: RecipeViewModel[] = recipes.map(r => ({
			name: r.name,
			paramSig: r.parameters.length > 0 ? r.parameters.map(p => p.name).join(" ") : undefined,
			doc: r.doc,
		}));
		this.description = prompt.render(justDescription, { recipes: view });
	}

	static async createIf(session: ToolSession): Promise<JustTool | null> {
		if (!session.settings.get("just.enabled")) return null;
		if (!$which("just")) return null;
		if (!findJustfileInCwd(session.cwd)) return null;
		const recipes = await dumpRecipes(session.cwd);
		if (!recipes || recipes.length === 0) return null;
		return new JustTool(session, recipes);
	}

	async execute(
		_toolCallId: string,
		input: JustParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<JustToolDetails>> {
		const command = `just ${input.just}`;
		const result = await executeBash(command, {
			cwd: this.session.cwd,
			signal,
		});
		const text = result.output || "(no output)";
		if (result.cancelled) {
			throw new ToolAbortError(result.output || "Command aborted");
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${text}\n\nCommand failed: missing exit status`);
		}
		const builder = toolResult<JustToolDetails>({ exitCode: result.exitCode })
			.text(text)
			.truncationFromSummary(result, { direction: "tail" });
		if (result.exitCode !== 0) {
			throw new ToolError(`${text}\n\nCommand exited with code ${result.exitCode}`);
		}
		return builder.done();
	}
}
