export const MAX_TITLE_INPUT_CHARS = 2000;

export function truncateTitleInput(message: string): string {
	return message.length > MAX_TITLE_INPUT_CHARS ? `${message.slice(0, MAX_TITLE_INPUT_CHARS)}…` : message;
}

export function formatTitleUserMessage(message: string): string {
	return `<user-message>\n${truncateTitleInput(message)}\n</user-message>`;
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
