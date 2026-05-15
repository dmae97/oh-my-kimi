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
		.union([
			z.literal("Added"),
			z.literal("Changed"),
			z.literal("Fixed"),
			z.literal("Deprecated"),
			z.literal("Removed"),
			z.literal("Security"),
			z.literal("Breaking Changes"),
		])
		.optional(),
	user_visible: z.boolean().optional(),
});
