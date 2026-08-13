import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractNpmPackageTarball } from "../src/index.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omk-package-archive-"));
	roots.push(root);
	return root;
}

function octal(value: number, width: number): Buffer {
	return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function tar(entries: Array<{ path: string; content?: string; type?: "0" | "2" | "5" }>): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const content = Buffer.from(entry.content ?? "", "utf8");
		const header = Buffer.alloc(512);
		header.write(entry.path, 0, 100, "utf8");
		octal(0o600, 8).copy(header, 100);
		octal(content.length, 12).copy(header, 124);
		header.write(entry.type ?? "0", 156, 1, "ascii");
		header.write("ustar\0", 257, 6, "ascii");
		header.fill(0x20, 148, 156);
		octal(
			[...header].reduce((sum, byte) => sum + byte, 0),
			8,
		).copy(header, 148);
		blocks.push(header, content);
		const padding = (512 - (content.length % 512)) % 512;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("npm package archive extraction", () => {
	it("extracts package files without dependencies or lifecycle execution", () => {
		const root = tempRoot();
		const archive = join(root, "fixture.tgz");
		const destination = join(root, "package");
		writeFileSync(
			archive,
			tar([
				{
					path: "package/package.json",
					content: JSON.stringify({ name: "fixture", scripts: { postinstall: "exit 99" } }),
				},
				{ path: "package/index.ts", content: "export default function () {};" },
			]),
		);

		extractNpmPackageTarball(archive, destination);

		expect(readFileSync(join(destination, "index.ts"), "utf8")).toContain("export default");
		expect(existsSync(join(destination, "node_modules"))).toBe(false);
	});

	it("rejects traversal entries", () => {
		const root = tempRoot();
		const archive = join(root, "traversal.tgz");
		writeFileSync(archive, tar([{ path: "package/../../escaped.txt", content: "bad" }]));

		expect(() => extractNpmPackageTarball(archive, join(root, "package"))).toThrow(/unsafe path/u);
		expect(existsSync(join(root, "escaped.txt"))).toBe(false);
	});

	it("rejects symbolic links", () => {
		const root = tempRoot();
		const archive = join(root, "symlink.tgz");
		writeFileSync(archive, tar([{ path: "package/link", type: "2" }]));

		expect(() => extractNpmPackageTarball(archive, join(root, "package"))).toThrow(/unsupported entry type/u);
	});
});
