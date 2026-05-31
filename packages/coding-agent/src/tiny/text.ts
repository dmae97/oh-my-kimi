export const MAX_TITLE_INPUT_CHARS = 2000;

/**
 * Minimum length of code-stripped input below which we fall back to the
 * original message. Guards against messages that are (almost) entirely a code
 * block — stripping would otherwise leave the model nothing to title from.
 */
const MIN_STRIPPED_TITLE_CHARS = 12;
/** Matches a fenced code block (3+ backticks), including an unterminated trailing fence. */
const FENCED_CODE_BLOCK = /```+[\s\S]*?(?:```+|$)/g;

export function truncateTitleInput(message: string): string {
	return message.length > MAX_TITLE_INPUT_CHARS ? `${message.slice(0, MAX_TITLE_INPUT_CHARS)}…` : message;
}

/**
 * Strip fenced code blocks from a message before titling.
 *
 * Small title models latch onto literal text inside code blocks — e.g. a pasted
 * UI mockup containing "Welcome to Claude Code v2.1.158" yields that string as
 * the title instead of the surrounding intent. Removing fenced blocks leaves the
 * prose that actually describes the task. Inline code (single backticks) is kept
 * — it is short, high-signal context like `/login`.
 *
 * Falls back to the original message when stripping leaves too little to title
 * (a message that is essentially just a code block).
 */
export function stripCodeBlocks(message: string): string {
	const cleaned = message
		.replace(FENCED_CODE_BLOCK, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return cleaned.length >= MIN_STRIPPED_TITLE_CHARS ? cleaned : message;
}

/** Prepare a raw user message for titling: drop code blocks, then bound length. */
export function prepareTitleInput(message: string): string {
	return truncateTitleInput(stripCodeBlocks(message));
}

export function formatTitleUserMessage(message: string): string {
	return `<user-message>\n${prepareTitleInput(message)}\n</user-message>`;
}

export function normalizeGeneratedTitle(value: string | null | undefined): string | null {
	const firstLine = value?.trim().split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) return null;
	const title = firstLine
		.replace(/^["']|["']$/g, "")
		.replace(/[.!?]$/, "")
		.trim();
	return title || null;
}
