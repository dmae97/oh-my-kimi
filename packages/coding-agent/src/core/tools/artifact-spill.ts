import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSize } from "./truncate.ts";

export interface SpillInput {
	readonly kind: "read" | "bash";
	readonly preview: string;
	readonly full: string;
	readonly truncated: boolean;
	readonly path: string;
}

export interface SpillResult {
	readonly preview: string;
	readonly path: string;
}

export function spillTruncatedOutput(input: SpillInput): SpillResult {
	if (!input.truncated) return { preview: input.preview, path: input.path };
	const directory = mkdtempSync(join(tmpdir(), "omk-spill-"));
	chmodSync(directory, 0o700);
	const sourceDigest = createHash("sha256").update(input.path).digest("hex").slice(0, 16);
	const spillPath = join(directory, `${input.kind}-${sourceDigest}.txt`);
	try {
		writeFileSync(spillPath, input.full, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	const size = formatSize(Buffer.byteLength(input.full, "utf-8"));
	return {
		preview: `${input.preview}\n\n[Full ${input.kind} output spilled to ${spillPath} (${size}).]`,
		path: spillPath,
	};
}
