/**
 * Biome CLI-based linter client.
 * Uses Biome's CLI with JSON output instead of LSP (which has stale diagnostics issues).
 */
import path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../../lsp/types";

// =============================================================================
// Biome JSON Output Types
// =============================================================================

interface BiomeJsonOutput {
	diagnostics: BiomeDiagnostic[];
}

interface BiomeDiagnostic {
	category: string; // e.g., "lint/correctness/noUnusedVariables"
	severity: "error" | "warning" | "info" | "hint";
	description: string;
	location?: {
		path?: { file: string };
		span?: [number, number]; // [startOffset, endOffset] in bytes
		sourceCode?: string;
	};
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert byte offsets to line:column positions in a single pass over the source.
 */
function offsetsToPositions(source: string, offsets: number[]): Map<number, { line: number; column: number }> {
	const sorted = [...new Set(offsets)].sort((a, b) => a - b);
	const result = new Map<number, { line: number; column: number }>();
	let line = 1;
	let column = 1;
	let byteIndex = 0;
	let next = 0;

	for (const ch of source) {
		if (next >= sorted.length) break;
		const cp = ch.codePointAt(0) as number;
		const byteLen = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
		while (next < sorted.length && byteIndex + byteLen > sorted[next]) {
			result.set(sorted[next], { line, column });
			next++;
		}
		if (ch === "\n") {
			line++;
			column = 1;
		} else {
			column++;
		}
		byteIndex += byteLen;
	}

	// Offsets at or past end-of-file map to the final position.
	while (next < sorted.length) {
		result.set(sorted[next], { line, column });
		next++;
	}

	return result;
}

/**
 * Parse Biome severity to LSP DiagnosticSeverity.
 */
function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "info":
			return 3;
		case "hint":
			return 4;
		default:
			return 2;
	}
}

/**
 * Run a Biome CLI command.
 */
async function runBiome(
	args: string[],
	cwd: string,
	resolvedCommand?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const command = resolvedCommand ?? "biome";

	try {
		const proc = Bun.spawn([command, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;

		return { stdout, stderr, success: exitCode === 0 };
	} catch (err) {
		return { stdout: "", stderr: String(err), success: false };
	}
}

// Surface broken-binary / CLI failures once instead of silently reporting
// "no diagnostics" forever (and instead of spamming every writethrough).
const reportedBiomeFailures = new Set<string>();

function warnBiomeOnce(key: string, message: string, meta: Record<string, unknown>): void {
	if (reportedBiomeFailures.has(key)) return;
	reportedBiomeFailures.add(key);
	logger.warn(message, meta);
}

// =============================================================================
// Biome Client
// =============================================================================

/**
 * Biome CLI-based linter client.
 * Parses Biome's --reporter=json output into LSP Diagnostic format.
 */
export class BiomeClient implements LinterClient {
	/** Factory method for creating BiomeClient instances */
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new BiomeClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	async format(filePath: string, content: string): Promise<string> {
		// Write content to file first
		await Bun.write(filePath, content);

		// Run biome format --write
		const result = await runBiome(["format", "--write", filePath], this.cwd, this.config.resolvedCommand);

		if (result.success) {
			// Read back formatted content
			return await Bun.file(filePath).text();
		}

		// Format failed, return original
		return content;
	}

	async lint(filePath: string): Promise<Diagnostic[]> {
		// Run biome lint with JSON reporter
		const result = await runBiome(["lint", "--reporter=json", filePath], this.cwd, this.config.resolvedCommand);

		// Biome exits non-zero when diagnostics are found, so only an empty
		// stdout signals an actual run failure (missing binary, CLI error).
		if (!result.success && result.stdout.trim().length === 0) {
			warnBiomeOnce(`run:${this.cwd}`, "Biome lint failed; reporting no diagnostics", {
				cwd: this.cwd,
				stderr: result.stderr.slice(0, 500),
			});
			return [];
		}

		return this.#parseJsonOutput(result.stdout, filePath);
	}

	/**
	 * Parse Biome's JSON output into LSP Diagnostics.
	 */
	#parseJsonOutput(jsonOutput: string, targetFile: string): Diagnostic[] {
		const diagnostics: Diagnostic[] = [];

		let parsed: BiomeJsonOutput;
		try {
			parsed = JSON.parse(jsonOutput);
		} catch {
			warnBiomeOnce(`parse:${this.cwd}`, "Failed to parse Biome JSON output; reporting no diagnostics", {
				cwd: this.cwd,
				file: targetFile,
			});
			return diagnostics;
		}

		const target = path.resolve(targetFile);
		const relevant: BiomeDiagnostic[] = [];
		// Batch all span offsets per source text so each source is scanned once
		// instead of twice per diagnostic.
		const offsetsBySource = new Map<string, number[]>();
		for (const diag of parsed.diagnostics ?? []) {
			const location = diag.location;
			if (!location?.path?.file) continue;

			// Resolve file path
			const diagFile = path.isAbsolute(location.path.file)
				? location.path.file
				: path.join(this.cwd, location.path.file);

			// Only include diagnostics for the target file
			if (path.resolve(diagFile) !== target) {
				continue;
			}

			relevant.push(diag);
			if (location.span && location.sourceCode) {
				const offsets = offsetsBySource.get(location.sourceCode);
				if (offsets) offsets.push(location.span[0], location.span[1]);
				else offsetsBySource.set(location.sourceCode, [location.span[0], location.span[1]]);
			}
		}

		const positionsBySource = new Map<string, Map<number, { line: number; column: number }>>();
		for (const [source, offsets] of offsetsBySource) {
			positionsBySource.set(source, offsetsToPositions(source, offsets));
		}

		for (const diag of relevant) {
			const location = diag.location;
			let startLine = 1;
			let startColumn = 1;
			let endLine = 1;
			let endColumn = 1;

			if (location?.span && location.sourceCode) {
				const positions = positionsBySource.get(location.sourceCode);
				const startPos = positions?.get(location.span[0]);
				const endPos = positions?.get(location.span[1]);
				if (startPos) {
					startLine = startPos.line;
					startColumn = startPos.column;
				}
				if (endPos) {
					endLine = endPos.line;
					endColumn = endPos.column;
				}
			}

			diagnostics.push({
				range: {
					start: { line: startLine - 1, character: startColumn - 1 },
					end: { line: endLine - 1, character: endColumn - 1 },
				},
				severity: parseSeverity(diag.severity),
				message: diag.description,
				source: "biome",
				code: diag.category,
			});
		}

		return diagnostics;
	}

	dispose(): void {
		// Nothing to dispose for CLI client
	}
}
