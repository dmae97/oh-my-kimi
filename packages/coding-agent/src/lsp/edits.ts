import * as fs from "node:fs/promises";
import path from "node:path";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import type { CreateFile, DeleteFile, RenameFile, TextDocumentEdit, TextEdit, WorkspaceEdit } from "./types";
import { uriToFile } from "./utils";

// =============================================================================
// Text Edit Application
// =============================================================================

/**
 * Apply text edits to a string in-memory.
 * Edits are applied in reverse order (bottom-to-top) to preserve line/character indices.
 */
export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
	const lines = content.split("\n");

	// Sort edits in reverse order (bottom-to-top, right-to-left)
	const sortedEdits = [...edits].sort((a, b) => {
		if (a.range.start.line !== b.range.start.line) {
			return b.range.start.line - a.range.start.line;
		}
		return b.range.start.character - a.range.start.character;
	});

	for (const edit of sortedEdits) {
		const { start, end } = edit.range;

		// Single-line edit: replace substring within same line
		if (start.line === end.line) {
			const line = lines[start.line] || "";
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
		} else {
			// Multi-line edit: splice across multiple lines
			const startLine = lines[start.line] || "";
			const endLine = lines[end.line] || "";
			const newContent = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
			lines.splice(start.line, end.line - start.line + 1, ...newContent.split("\n"));
		}
	}

	return lines.join("\n");
}

/**
 * Apply text edits to a file.
 * Edits are applied in reverse order (bottom-to-top) to preserve line/character indices.
 */
export async function applyTextEdits(filePath: string, edits: TextEdit[]): Promise<void> {
	const content = await Bun.file(filePath).text();
	const result = applyTextEditsToString(content, edits);
	await Bun.write(filePath, result);
}

// =============================================================================
// Workspace Edit Application
// =============================================================================

/**
 * Apply a workspace edit (collection of file changes).
 * Returns array of applied change descriptions.
 */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, cwd: string): Promise<string[]> {
	const applied: string[] = [];

	// Handle changes map (legacy format)
	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			const filePath = uriToFile(uri);
			await applyTextEdits(filePath, textEdits);
			applied.push(`Applied ${textEdits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
		}
	}

	// Handle documentChanges array (modern format)
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
				// TextDocumentEdit
				const docChange = change as TextDocumentEdit;
				const filePath = uriToFile(docChange.textDocument.uri);
				const textEdits = docChange.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
				await applyTextEdits(filePath, textEdits);
				applied.push(`Applied ${textEdits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
			} else if ("kind" in change && change.kind) {
				// Resource operations
				if (change.kind === "create") {
					const createOp = change as CreateFile;
					const filePath = uriToFile(createOp.uri);
					await Bun.write(filePath, "");
					applied.push(`Created ${formatPathRelativeToCwd(filePath, cwd)}`);
				} else if (change.kind === "rename") {
					const renameOp = change as RenameFile;
					const oldPath = uriToFile(renameOp.oldUri);
					const newPath = uriToFile(renameOp.newUri);
					await fs.mkdir(path.dirname(newPath), { recursive: true });
					await fs.rename(oldPath, newPath);
					applied.push(
						`Renamed ${formatPathRelativeToCwd(oldPath, cwd)} → ${formatPathRelativeToCwd(newPath, cwd)}`,
					);
				} else if (change.kind === "delete") {
					const deleteOp = change as DeleteFile;
					const filePath = uriToFile(deleteOp.uri);
					await fs.rm(filePath, { recursive: true });
					applied.push(`Deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
				}
			}
		}
	}

	return applied;
}
