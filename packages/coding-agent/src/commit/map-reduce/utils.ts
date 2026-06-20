export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[…${text.length - maxChars}ch elided…]`;
}
