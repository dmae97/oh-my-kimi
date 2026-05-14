import { type TSchema, Type } from "@sinclair/typebox";
import type { CommitAgentState } from "../../../commit/agentic/state";
import { CHANGELOG_CATEGORIES, type ChangelogCategory } from "../../../commit/types";
import type { CustomTool } from "../../../extensibility/custom-tools/types";

const changelogEntryProperties = CHANGELOG_CATEGORIES.reduce<Record<ChangelogCategory, TSchema>>(
	(acc, category) => {
		acc[category] = Type.Optional(Type.Array(Type.String()));
		return acc;
	},
	{} as Record<ChangelogCategory, TSchema>,
);

const changelogEntriesSchema = Type.Object(changelogEntryProperties);
const changelogDeletionsSchema = Type.Object(changelogEntryProperties, {
	description: "Entries to remove from existing changelog sections (case-insensitive match)",
});

const changelogEntrySchema = Type.Object({
	path: Type.String(),
	entries: changelogEntriesSchema,
	deletions: Type.Optional(changelogDeletionsSchema),
});

const proposeChangelogSchema = Type.Object({
	entries: Type.Array(changelogEntrySchema),
});

interface ChangelogResponse {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

const allowedCategories = new Set<ChangelogCategory>(CHANGELOG_CATEGORIES);

export function createProposeChangelogTool(
	state: CommitAgentState,
	changelogTargets: string[],
): CustomTool<typeof proposeChangelogSchema> {
	return {
		name: "propose_changelog",
		label: "Propose Changelog",
		description: "Provide changelog entries for targeted CHANGELOG.md files.",
		parameters: proposeChangelogSchema,
		async execute(_toolCallId, params) {
			const errors: string[] = [];
			const warnings: string[] = [];
			const targets = new Set(changelogTargets);
			const seen = new Set<string>();

			const normalized = params.entries.map(entry => {
				const cleaned: Record<string, string[]> = {};
				const entries = entry.entries as Record<string, string[]>;
				for (const [category, values] of Object.entries(entries)) {
					if (!allowedCategories.has(category as ChangelogCategory)) {
						errors.push(`Unknown changelog category for ${entry.path}: ${category}`);
						continue;
					}
					if (!Array.isArray(values)) {
						errors.push(`Invalid changelog entries for ${entry.path}: ${category}`);
						continue;
					}
					const items = values.map(value => value.trim().replace(/\.$/, "")).filter(value => value.length > 0);
					if (items.length > 0) {
						cleaned[category] = Array.from(new Set(items));
					}
				}

				let cleanedDeletions: Record<string, string[]> | undefined;
				if (entry.deletions) {
					cleanedDeletions = {};
					const deletions = entry.deletions as Record<string, string[]>;
					for (const [category, values] of Object.entries(deletions)) {
						if (!allowedCategories.has(category as ChangelogCategory)) {
							errors.push(`Unknown deletion category for ${entry.path}: ${category}`);
							continue;
						}
						if (!Array.isArray(values)) {
							errors.push(`Invalid deletion entries for ${entry.path}: ${category}`);
							continue;
						}
						const items = values.map(value => value.trim()).filter(value => value.length > 0);
						if (items.length > 0) {
							cleanedDeletions[category] = Array.from(new Set(items));
						}
					}
					if (Object.keys(cleanedDeletions).length === 0) {
						cleanedDeletions = undefined;
					}
				}

				if (Object.keys(cleaned).length === 0 && !cleanedDeletions) {
					warnings.push(`No changelog entries provided for ${entry.path}.`);
				}
				return {
					path: entry.path,
					entries: cleaned,
					deletions: cleanedDeletions,
				};
			});

			for (const entry of normalized) {
				if (targets.size > 0 && !targets.has(entry.path)) {
					errors.push(`Changelog not expected: ${entry.path}`);
					continue;
				}
				if (seen.has(entry.path)) {
					errors.push(`Duplicate changelog entry for ${entry.path}`);
					continue;
				}
				seen.add(entry.path);
			}

			if (targets.size > 0) {
				for (const target of targets) {
					if (!seen.has(target)) {
						errors.push(`Missing changelog entries for ${target}`);
					}
				}
			}

			const response: ChangelogResponse = {
				valid: errors.length === 0,
				errors,
				warnings,
			};

			if (response.valid) {
				state.changelogProposal = { entries: normalized };
			}

			let text = response.valid ? "Changelog entries accepted." : "Changelog validation failed.";
			if (response.errors.length > 0) {
				text += `\n\nErrors:\n${response.errors.map(e => `- ${e}`).join("\n")}`;
			}
			if (response.warnings.length > 0) {
				text += `\n\nWarnings:\n${response.warnings.map(w => `- ${w}`).join("\n")}`;
			}
			return {
				content: [{ type: "text", text }],
				details: response,
			};
		},
	};
}
