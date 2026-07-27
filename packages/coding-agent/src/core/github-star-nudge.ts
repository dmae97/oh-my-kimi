/**
 * Persistent GitHub star nudge for interactive startup.
 * Unstarred installs keep getting reminded until the operator marks starred via /star.
 */

export const OMK_GITHUB_REPO_URL = "https://github.com/dmae97/omk";
export const OMK_GITHUB_STAR_URL = "https://github.com/dmae97/omk";

export interface GithubStarNudgeState {
	/** True once the operator confirmed they starred (or already starred). */
	readonly githubStarred?: boolean;
}

/** Show on every interactive startup until the operator marks starred. */
export function shouldShowGithubStarNudge(state: GithubStarNudgeState): boolean {
	return state.githubStarred !== true;
}

export function githubStarNudgeTitle(): string {
	return "Star OMK on GitHub";
}

export function githubStarNudgeBody(): string {
	return [
		"First install or still no star? Hit the star button — it keeps the project alive.",
		`Repo: ${OMK_GITHUB_STAR_URL}`,
		"After starring, run /star so this stops nagging. Until then it comes back every launch.",
	].join("\n");
}
