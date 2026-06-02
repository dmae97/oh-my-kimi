const HASHLINE_HEADER_RE = /^\s*(?:¶|§|@)([^\s#]+)(?:#[^\s]+)?(?:\s|$)/;

function stringField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractHashlinePath(input: string): string | undefined {
	return HASHLINE_HEADER_RE.exec(input)?.[1];
}

/** Adds derived compatibility fields to tool event input without changing tool execution parameters. */
export function normalizeToolEventInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
	if (toolName !== "edit" || stringField(input, "path")) return input;

	const directPath = stringField(input, "_path");
	if (directPath) return { ...input, path: directPath };

	const rawInput = stringField(input, "input") ?? stringField(input, "_input");
	const hashlinePath = rawInput ? extractHashlinePath(rawInput) : undefined;
	return hashlinePath ? { ...input, path: hashlinePath } : input;
}
