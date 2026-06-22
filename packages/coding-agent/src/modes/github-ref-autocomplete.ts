/**
 * Autocomplete for GitHub issue/PR references typed as `#<number>` (e.g. `#3164`).
 *
 * Mirrors the `@` file-reference and `scheme://` internal-url conventions: the
 * `#<number>` token is rewritten to an internal URL (`pr://3164` or
 * `issue://3164`) plus a trailing space, and the existing tool-mediated pipeline
 * (the `read` tool → InternalUrlRouter → `gh`) resolves it from the session
 * cwd's git remote.
 *
 * No network at suggestion time — candidates are generated locally. GitHub
 * shares the issue/PR number space and there is no cheap way to tell which a
 * given number is while typing, so both a PR and an Issue candidate are offered
 * (PR first — the more common reference in a coding context) and the user
 * disambiguates by accepting the right one. Anything that is not a pure `#<digits>`
 * token keeps falling through to the existing prompt-action menu.
 */
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";

/** Candidates offered for a `#<number>` token, in display order. */
const GITHUB_REF_KINDS = [
	{ scheme: "pr", label: "PR", description: "GitHub pull request" },
	{ scheme: "issue", label: "Issue", description: "GitHub issue" },
] as const;

/**
 * Detect a `#<number>` token ending at the cursor. Only a `#` followed by a
 * positive integer (no leading zeros) qualifies, so `#3164` matches but `#`,
 * `#0`, `#0123`, `#copy`, and `#3164abc` do not.
 */
export function getGithubRefPrefix(textBeforeCursor: string): string | null {
	const hashIndex = textBeforeCursor.lastIndexOf("#");
	if (hashIndex === -1) return null;
	const token = textBeforeCursor.slice(hashIndex + 1);
	if (!/^[1-9]\d*$/.test(token)) return null;
	return `#${token}`;
}

/**
 * Suggestions for a `#<number>` token: a PR candidate and an Issue candidate,
 * each rewriting to the corresponding internal URL on accept. Returns `null`
 * when the text before the cursor is not a `#<number>` token.
 */
export function getGithubRefSuggestions(
	textBeforeCursor: string,
): { items: AutocompleteItem[]; prefix: string } | null {
	const prefix = getGithubRefPrefix(textBeforeCursor);
	if (!prefix) return null;
	const number = prefix.slice(1);
	const items: AutocompleteItem[] = GITHUB_REF_KINDS.map(kind => ({
		value: `${kind.scheme}://${number}`,
		label: `${kind.label} #${number}`,
		description: kind.description,
	}));
	return { items, prefix };
}
