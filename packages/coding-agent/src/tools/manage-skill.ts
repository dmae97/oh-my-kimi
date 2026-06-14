import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { z } from "zod/v4";
import { deleteManagedSkill, getManagedSkillsDir, writeManagedSkill } from "../autolearn/managed-skills";
import manageSkillDescription from "../prompts/tools/manage-skill.md" with { type: "text" };
import type { ToolSession } from ".";

const manageSkillSchema = z.object({
	action: z.enum(["create", "update", "delete"]),
	name: z.string().describe("kebab-case skill name"),
	description: z
		.string()
		.describe("one-line description of when to use the skill (required for create/update)")
		.optional(),
	body: z.string().describe("the SKILL.md body in markdown, no frontmatter (required for create/update)").optional(),
});

export type ManageSkillParams = z.infer<typeof manageSkillSchema>;

/**
 * Direct create/update/delete of isolated managed skills. Gated behind
 * `autolearn.enabled`; backend-independent (the skill side is standalone).
 */
export class ManageSkillTool implements AgentTool<typeof manageSkillSchema> {
	readonly name = "manage_skill";
	readonly approval = "write" as const;
	readonly label = "Manage Skill";
	readonly description = manageSkillDescription;
	readonly parameters = manageSkillSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Create, update, or delete an isolated managed skill";

	// No session state needed: createIf reads settings; writes target the
	// home-based managed-skills dir directly.
	static createIf(session: ToolSession): ManageSkillTool | null {
		if (!session.settings.get("autolearn.enabled")) return null;
		return new ManageSkillTool();
	}

	async execute(_id: string, params: ManageSkillParams): Promise<AgentToolResult> {
		if (params.action === "delete") {
			await deleteManagedSkill(params.name);
			return {
				content: [{ type: "text", text: `Deleted managed skill "${params.name}".` }],
				details: { action: "delete", name: params.name },
			};
		}

		if (!params.description || !params.body) {
			throw new Error(`"${params.action}" requires both "description" and "body".`);
		}
		const { path: skillPath } = await writeManagedSkill({
			action: params.action,
			name: params.name,
			description: params.description,
			body: params.body,
		});
		const relativePath = path.relative(getManagedSkillsDir(), skillPath);
		const verb = params.action === "create" ? "Created" : "Updated";
		return {
			content: [{ type: "text", text: `${verb} managed skill "${params.name}" (managed-skills/${relativePath}).` }],
			details: { action: params.action, name: params.name },
		};
	}
}
