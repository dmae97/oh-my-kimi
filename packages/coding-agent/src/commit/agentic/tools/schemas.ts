import * as z from "zod/v4";

export const commitTypeSchema = z.enum([
	"feat",
	"fix",
	"refactor",
	"perf",
	"docs",
	"test",
	"build",
	"ci",
	"chore",
	"style",
	"revert",
] as const);

export const detailSchema = z.object({
	text: z.string(),
	changelog_category: z
		.enum(["Added", "Changed", "Fixed", "Deprecated", "Removed", "Security", "Breaking Changes"])
		.optional(),
	user_visible: z.boolean().optional(),
});
