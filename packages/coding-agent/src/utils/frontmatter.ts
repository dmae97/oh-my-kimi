import { parse } from "yaml";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const FRONTMATTER_OPEN = /^---(?:[ \t]*\r?\n|$)/m;

/**
 * Locate YAML frontmatter even when a short preamble (comments/HTML) precedes the opening fence.
 * bigpowers and similar skill packs emit story markers before `---`.
 */
const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(content);

	const openMatch = FRONTMATTER_OPEN.exec(normalized);
	if (!openMatch || openMatch.index === undefined) {
		return { yamlString: null, body: normalized };
	}

	// Reject preambles that already look like document body (too long / has headings beyond comments).
	const preamble = normalized.slice(0, openMatch.index);
	if (preamble.length > 0) {
		const preambleLines = preamble.split("\n").filter((line) => line.trim().length > 0);
		const onlyPreambleNoise = preambleLines.every(
			(line) =>
				line.trimStart().startsWith("#") ||
				line.trimStart().startsWith("<!--") ||
				line.trim() === "-->" ||
				/^ARCHIVED:/i.test(line.trim()),
		);
		if (!onlyPreambleNoise || preambleLines.length > 32) {
			return { yamlString: null, body: normalized };
		}
	}

	const yamlStart = openMatch.index + openMatch[0].length;
	const endIndex = normalized.indexOf("\n---", yamlStart - 1);
	if (endIndex === -1 || endIndex < yamlStart) {
		return { yamlString: null, body: normalized };
	}

	// Closing fence must be a line that is exactly `---` (optional trailing spaces).
	const afterClose = normalized.slice(endIndex + 1); // starts at ---
	if (!/^---[ \t]*(?:\n|$)/.test(afterClose)) {
		return { yamlString: null, body: normalized };
	}

	const closeLineEnd = afterClose.search(/\n/);
	const bodyStart = closeLineEnd === -1 ? normalized.length : endIndex + 1 + closeLineEnd + 1;

	return {
		yamlString: normalized.slice(yamlStart, endIndex),
		body: normalized.slice(bodyStart).trim(),
	};
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) {
		return { frontmatter: {} as T, body };
	}
	const parsed = parse(yamlString);
	return { frontmatter: (parsed ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
