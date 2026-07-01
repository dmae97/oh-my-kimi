#!/usr/bin/env bun

/**
 * Populate, check, or reset the embedded harness documentation index for `omp://`.
 *
 * `--generate` writes `src/internal-urls/docs-index.generated.txt` as two lines:
 * a plain JSON array of the sorted `docs/**\/*.md` file names, then a base64
 * gzip blob of the index-aligned doc bodies (`string[]`). `--check` rebuilds
 * that payload from the real docs corpus and compares it to the embed when
 * present; the checked-in empty placeholder is accepted after verifying that a
 * fresh generated payload round-trips. `--reset` restores the placeholder so the
 * dev tree reads `docs/` from disk. Mirrors the stats / model-catalog embeds.
 */

import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Glob } from "bun";

const docsDir = path.resolve(import.meta.dir, "../../../docs");
const outputPath = path.resolve(import.meta.dir, "../src/internal-urls/docs-index.generated.txt");
const GENERATE_FLAG = "--generate";
const RESET_FLAG = "--reset";
const CHECK_FLAG = "--check";

export interface DocsIndexPayload {
	/** Sorted `docs/**\/*.md` file names plus index-aligned bodies and embed text. */
	readonly files: readonly string[];
	readonly bodies: readonly string[];
	readonly payload: string;
}

export interface DecodedDocsIndexPayload {
	/** Sorted `docs/**\/*.md` file names decoded from an embed payload. */
	readonly files: readonly string[];
	/** Index-aligned Markdown bodies decoded from an embed payload. */
	readonly bodies: readonly string[];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Build the exact two-line `omp://` docs embed from the source `docs/**\/*.md` corpus. */
export async function buildDocsIndexPayload(): Promise<DocsIndexPayload> {
	const glob = new Glob("**/*.md");
	const files: string[] = [];
	for await (const relativePath of glob.scan(docsDir)) {
		files.push(relativePath.split(path.sep).join("/"));
	}
	files.sort();

	const bodies = await Promise.all(files.map(file => Bun.file(path.join(docsDir, file)).text()));
	const bodiesB64 = Buffer.from(gzipSync(Buffer.from(JSON.stringify(bodies)), { level: 9 })).toString("base64");
	return {
		files,
		bodies,
		payload: `${JSON.stringify(files)}\n${bodiesB64}`,
	};
}

/** Decode a populated docs embed payload into filenames and index-aligned Markdown bodies. */
export function decodeDocsIndexPayload(embed: string): DecodedDocsIndexPayload | null {
	const newline = embed.indexOf("\n");
	if (newline === -1) return null;

	const filenames: unknown = JSON.parse(embed.slice(0, newline));
	if (!isStringArray(filenames)) {
		throw new Error("Embedded docs index filename line is not a JSON string array.");
	}

	const inflated = gunzipSync(Buffer.from(embed.slice(newline + 1), "base64"));
	const bodies: unknown = JSON.parse(inflated.toString("utf8"));
	if (!isStringArray(bodies)) {
		throw new Error("Embedded docs index body blob is not a JSON string array.");
	}

	return { files: filenames, bodies };
}

/**
 * Assert that an embed payload is fresh against the current source docs payload.
 * An empty placeholder is accepted by round-tripping the expected payload (the
 * dev tree and post-build reset state both checked-in placeholders).
 */
export function assertDocsIndexFresh(embed: string, expected: DecodedDocsIndexPayload): void {
	const source =
		embed.length > 0
			? embed
			: `${JSON.stringify(expected.files)}\n${Buffer.from(gzipSync(Buffer.from(JSON.stringify(expected.bodies)), { level: 9 })).toString("base64")}`;
	const decoded = decodeDocsIndexPayload(source);
	if (decoded === null) {
		throw new Error("Embedded docs index is malformed: missing newline separator.");
	}
	if (decoded.files.length !== expected.files.length) {
		throw new Error(
			`Embedded docs index has ${decoded.files.length} docs; source corpus has ${expected.files.length}.`,
		);
	}
	if (decoded.bodies.length !== expected.bodies.length) {
		throw new Error(
			`Embedded docs index has ${decoded.bodies.length} bodies; source corpus has ${expected.bodies.length}.`,
		);
	}
	for (let i = 0; i < expected.files.length; i++) {
		if (decoded.files[i] !== expected.files[i]) {
			throw new Error(
				`Embedded docs index filename mismatch at ${i}: ${decoded.files[i] ?? "<missing>"} !== ${expected.files[i]}.`,
			);
		}
		if (decoded.bodies[i] !== expected.bodies[i]) {
			throw new Error(`Embedded docs index body mismatch for ${expected.files[i]}. Run \`bun run gen:docs\`.`);
		}
	}
}

async function main(): Promise<void> {
	const rel = path.relative(process.cwd(), outputPath);

	if (process.argv.includes(RESET_FLAG)) {
		await Bun.write(outputPath, "");
		process.stdout.write(`Reset ${rel}\n`);
		return;
	}

	if (process.argv.includes(CHECK_FLAG)) {
		const current = await buildDocsIndexPayload();
		const embed = await Bun.file(outputPath).text();
		assertDocsIndexFresh(embed, current);
		process.stdout.write(`Docs index fresh for ${current.files.length} docs (${rel})\n`);
		return;
	}

	if (!process.argv.includes(GENERATE_FLAG)) {
		process.stdout.write(
			`Skipping ${rel}; pass ${GENERATE_FLAG} to embed docs (the dev tree reads docs/ from disk)\n`,
		);
		return;
	}

	const current = await buildDocsIndexPayload();
	assertDocsIndexFresh(current.payload, current);
	await Bun.write(outputPath, current.payload);
	process.stdout.write(`Generated ${rel} (${current.files.length} docs, ${current.payload.length} bytes)\n`);
}

if (import.meta.main) {
	await main();
}
