/**
 * Post-build script: reads the napi-rs generated `index.d.ts` and appends
 * runtime enum objects to `index.js`.
 *
 * napi-rs `#[napi(string_enum)]` emits `const enum` in the .d.ts — a
 * TypeScript-only construct with no JS runtime value. This script bridges
 * the gap so consumers can use enum values at runtime.
 *
 * Run after `napi build`: `bun packages/natives/scripts/gen-enums.ts`
 */
import * as path from "node:path";

const nativeDir = path.resolve(import.meta.dir, "../native");
const dtsPath = path.join(nativeDir, "index.d.ts");
const jsPath = path.join(nativeDir, "index.js");

// Match each `export declare const enum Name { ... }` block.
// The closing `}` is matched only at line start (enum bodies are indented).
const CONST_ENUM_RE = /export declare const enum (\w+)\s*\{(.*?)\n\}/gs;

export async function generateEnumExports(): Promise<void> {
	const dts = await Bun.file(dtsPath).text();
	const enums: string[] = [];
	CONST_ENUM_RE.lastIndex = 0;

	for (;;) {
		const match = CONST_ENUM_RE.exec(dts);
		if (match === null) break;

		const name = match[1];
		const body = match[2];
		const entries: string[] = [];

		for (const line of body!.split("\n")) {
			const m = line.match(/^\s*(\w+)\s*=\s*'([^']*)'/) ?? line.match(/^\s*(\w+)\s*=\s*(\d+)/);
			if (m) {
				const value = m[2]!.match(/^\d+$/) ? m[2] : `'${m[2]}'`;
				entries.push(`  ${m[1]}: ${value},`);
			}
		}

		if (entries.length > 0) {
			enums.push(`module.exports.${name} = {\n${entries.join("\n")}\n};`);
		}
	}

	if (enums.length === 0) {
		throw new Error("No const enums found in index.d.ts — check napi build output");
	}

	// Read current index.js and replace the generated enum block (between markers)
	const MARKER_START = "// --- generated const enum exports (do not edit) ---";
	const MARKER_END = "// --- end generated const enum exports ---";
	const enumBlock = `${MARKER_START}\n${enums.join("\n")}\n${MARKER_END}\n`;

	let js = await Bun.file(jsPath).text();

	const startIdx = js.indexOf(MARKER_START);
	const endIdx = js.indexOf(MARKER_END);

	if (startIdx !== -1 && endIdx !== -1) {
		js = js.slice(0, startIdx) + enumBlock;
	} else {
		js = `${js.trimEnd()}\n\n${enumBlock}`;
	}

	await Bun.write(jsPath, js);

	// Also fix the .d.ts: replace `const enum` with `enum` so TS allows
	// assigning string literals to enum types without casts.
	let dtsContent = await Bun.file(dtsPath).text();
	const constEnumCount = (dtsContent.match(/export declare const enum/g) || []).length;
	dtsContent = dtsContent.replaceAll("export const enum", "export declare enum");
	dtsContent = dtsContent.replaceAll("export declare const enum", "export declare enum");
	await Bun.write(dtsPath, dtsContent);

	console.log(`Generated ${enums.length} enum exports in index.js, fixed ${constEnumCount} const enums in index.d.ts`);
}

if (import.meta.main) {
	await generateEnumExports();
}
