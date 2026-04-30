import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { peekFile, peekFileSync } from "../src/peek-file";

function rangeBuffer(length: number): Buffer {
	return Buffer.from(Array.from({ length }, (_, index) => index % 256));
}

function bytesOf(input: Uint8Array): number[] {
	return Array.from(input);
}

describe("peekFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peek-file-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads an exact header slice asynchronously", async () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(1024);
		fs.writeFileSync(filePath, content);

		const header = await peekFile(filePath, 37, bytes => bytes.slice());
		expect(bytesOf(header)).toEqual(bytesOf(content.subarray(0, 37)));
	});

	it("reads an exact header slice synchronously", () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(2048);
		fs.writeFileSync(filePath, content);

		const header = peekFileSync(filePath, 777, bytes => bytes.slice());
		expect(bytesOf(header)).toEqual(bytesOf(content.subarray(0, 777)));
	});

	it("serves concurrent async peeks without corrupting buffers", async () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(4096);
		fs.writeFileSync(filePath, content);

		const lengths = [17, 33, 64, 128, 257, 511, 512, 513, 777, 1024, 1536, 2048];
		const headers = await Promise.all(lengths.map(length => peekFile(filePath, length, bytes => bytes.slice())));
		expect(headers).toHaveLength(lengths.length);
		for (const [index, header] of headers.entries()) {
			expect(bytesOf(header)).toEqual(bytesOf(content.subarray(0, lengths[index])));
		}
	});
});
