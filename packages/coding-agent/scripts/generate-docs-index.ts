#!/usr/bin/env bun

/**
 * Populate (or reset) the embedded harness documentation index for `omp://`.
 *
 * `--generate` writes `src/internal-urls/docs-index.generated.txt` as two lines:
 * a plain JSON array of the sorted `docs/**\/*.md` file names, then a base64
 * gzip blob of the index-aligned doc bodies (`string[]`). Keeping the filename
 * list out of the blob lets the loader list docs without inflating it.
 * Compiled binaries and the prepacked npm bundle inline this (~0.5MB) instead of
 * the ~1.6MB raw map; `--reset` restores the checked-in empty placeholder so the
 * dev tree reads `docs/` from disk. Mirrors the stats / model-catalog embeds.
 */

import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { Glob } from "bun";

const docsDir = path.resolve(import.meta.dir, "../../../docs");
const outputPath = path.resolve(import.meta.dir, "../src/internal-urls/docs-index.generated.txt");
const GENERATE_FLAG = "--generate";
const RESET_FLAG = "--reset";

async function main(): Promise<void> {
	const rel = path.relative(process.cwd(), outputPath);

	if (process.argv.includes(RESET_FLAG)) {
		await Bun.write(outputPath, "");
		console.log(`Reset ${rel}`);
		return;
	}

	if (!process.argv.includes(GENERATE_FLAG)) {
		console.log(`Skipping ${rel}; pass ${GENERATE_FLAG} to embed docs (the dev tree reads docs/ from disk)`);
		return;
	}

	const glob = new Glob("**/*.md");
	const files: string[] = [];
	for await (const relativePath of glob.scan(docsDir)) {
		files.push(relativePath.split(path.sep).join("/"));
	}
	files.sort();

	// Index-aligned bodies (Promise.all preserves order), kept separate from the
	// filename list so the loader can list docs without inflating the blob.
	const bodies = await Promise.all(files.map(file => Bun.file(path.join(docsDir, file)).text()));

	const bodiesB64 = Buffer.from(gzipSync(Buffer.from(JSON.stringify(bodies)), { level: 9 })).toString("base64");
	// Two lines: plain filename array, then the base64 gzip blob.
	const payload = `${JSON.stringify(files)}\n${bodiesB64}`;
	await Bun.write(outputPath, payload);
	console.log(`Generated ${rel} (${files.length} docs, ${payload.length} bytes)`);
}

await main();
