import path from "node:path";

/**
 * One file's contribution to a grouped file output. The header itself is generated
 * by `formatGroupedFiles` (single `#` for root files, `##` for files inside a dir);
 * use `headerSuffix` to tack on extras like ` (1 replacement)`.
 */
export interface GroupedFileSection {
	/** Optional suffix appended to the file header. */
	headerSuffix?: string;
	/** Body lines emitted into the textual model output. */
	modelLines: string[];
	/** Body lines emitted into the display output. Defaults to `modelLines`. */
	displayLines?: string[];
	/** When true, the file (and its header) is omitted entirely. */
	skip?: boolean;
}

export interface GroupedFilesOutput {
	model: string[];
	display: string[];
}

/**
 * Render a list of files as directory-grouped sections shared by grep, ast-grep,
 * ast-edit, and the LSP diagnostic formatter.
 *
 * Layout:
 *   # dir/
 *   ## file.ts
 *   …body…
 *
 *   # otherdir/
 *   ## other.ts
 *   …body…
 *
 * Files in the project root (directory `.`) become single-`#` headers without a
 * `## file` line, matching the existing convention.
 */
export function formatGroupedFiles(
	files: string[],
	renderFile: (filePath: string) => GroupedFileSection,
): GroupedFilesOutput {
	const filesByDirectory = new Map<string, string[]>();
	for (const filePath of files) {
		const directory = path.dirname(filePath).replace(/\\/g, "/");
		if (!filesByDirectory.has(directory)) {
			filesByDirectory.set(directory, []);
		}
		filesByDirectory.get(directory)!.push(filePath);
	}

	const model: string[] = [];
	const display: string[] = [];

	const pushSeparatorIfNeeded = () => {
		if (model.length > 0) {
			model.push("");
			display.push("");
		}
	};

	for (const [directory, dirFiles] of filesByDirectory) {
		if (directory === ".") {
			for (const filePath of dirFiles) {
				const section = renderFile(filePath);
				if (section.skip) continue;
				pushSeparatorIfNeeded();
				const header = `# ${path.basename(filePath)}${section.headerSuffix ?? ""}`;
				model.push(header, ...section.modelLines);
				display.push(header, ...(section.displayLines ?? section.modelLines));
			}
			continue;
		}

		const sections: Array<{ filePath: string; section: GroupedFileSection }> = [];
		for (const filePath of dirFiles) {
			const section = renderFile(filePath);
			if (section.skip) continue;
			sections.push({ filePath, section });
		}
		if (sections.length === 0) continue;

		pushSeparatorIfNeeded();
		const dirHeader = `# ${directory}/`;
		model.push(dirHeader);
		display.push(dirHeader);
		for (const { filePath, section } of sections) {
			const fileHeader = `## ${path.basename(filePath)}${section.headerSuffix ?? ""}`;
			model.push(fileHeader, ...section.modelLines);
			display.push(fileHeader, ...(section.displayLines ?? section.modelLines));
		}
	}

	return { model, display };
}
