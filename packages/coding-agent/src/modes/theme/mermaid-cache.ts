import { renderMermaidAsciiSafe } from "@oh-my-pi/pi-utils";

const cache = new Map<string, string | null>();

function normalizeMermaidSource(source: string): string {
	return source.replace(/\r\n?/g, "\n").trim();
}

/**
 * Resolve mermaid ASCII from fenced block source text.
 * Returns null when rendering fails, while memoizing failures to avoid repeated work.
 */
export function resolveMermaidAscii(source: string): string | null {
	const normalizedSource = normalizeMermaidSource(source);
	if (cache.has(normalizedSource)) {
		return cache.get(normalizedSource) ?? null;
	}

	const ascii = normalizedSource ? renderMermaidAsciiSafe(normalizedSource) : null;
	cache.set(normalizedSource, ascii);
	return ascii;
}

/**
 * Clear the mermaid cache.
 */
export function clearMermaidCache(): void {
	cache.clear();
}
