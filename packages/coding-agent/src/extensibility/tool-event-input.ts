const HASHLINE_FILE_PREFIX = "¶";

function stringField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeHashlineHeaderPath(body: string): string | undefined {
	const trimmed = body.trim();
	if (trimmed.length === 0) return undefined;
	const hashStart = /#[^\s#]+$/u.exec(trimmed)?.index;
	const rawPath = hashStart === undefined ? trimmed : trimmed.slice(0, hashStart);
	if (rawPath.length < 2) return rawPath.length > 0 ? rawPath : undefined;
	const first = rawPath[0];
	const last = rawPath[rawPath.length - 1];
	if ((first === '"' || first === "'") && first === last) return rawPath.slice(1, -1);
	return rawPath;
}

function extractHashlinePaths(input: string): string[] {
	const paths: string[] = [];
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "").trimStart();
		if (!line.startsWith(HASHLINE_FILE_PREFIX)) continue;
		let prefixEnd = 0;
		while (prefixEnd < line.length && line[prefixEnd] === HASHLINE_FILE_PREFIX) prefixEnd++;
		const path = normalizeHashlineHeaderPath(line.slice(prefixEnd));
		if (path) paths.push(path);
	}
	return paths;
}

/** Adds derived compatibility fields to tool event input without changing tool execution parameters. */
export function normalizeToolEventInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
	if (toolName !== "edit" || stringField(input, "path")) return input;

	const directPath = stringField(input, "_path");
	if (directPath) return { ...input, path: directPath };

	const rawInput = stringField(input, "input") ?? stringField(input, "_input");
	const hashlinePaths = rawInput ? extractHashlinePaths(rawInput) : [];
	if (hashlinePaths.length === 0) return input;
	if (hashlinePaths.length === 1) return { ...input, path: hashlinePaths[0], paths: hashlinePaths };
	return { ...input, paths: hashlinePaths };
}
