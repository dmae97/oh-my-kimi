import { describe, expect, test } from "bun:test";
import { MemorySessionStorage } from "../src/session/session-storage";

describe("MemorySessionStorage chunked mirror (F2)", () => {
	test("writeLineSync builds the same content as a single writeTextSync of the join", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/session.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			const N = 1000;
			for (let i = 0; i < N; i++) {
				writer.writeLineSync(`{"i":${i}}\n`);
			}
		} finally {
			await writer.close();
		}

		// Construct the baseline from the same parts.
		const expected = Array.from({ length: 1000 }, (_, i) => `{"i":${i}}\n`).join("");
		const actual = storage.readTextSync(path);
		expect(actual).toBe(expected);
		expect(actual.length).toBe(expected.length);
	});

	test("statSync reports UTF-8 byte length, not character count", () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/unicode.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			writer.writeLineSync("héllo\n"); // é = 2 bytes in UTF-8
			writer.writeLineSync("日本語\n"); // 3 chars × 3 bytes = 9
		} finally {
			void writer.close();
		}

		const expectedBytes = Buffer.byteLength("héllo\n日本語\n", "utf-8");
		expect(storage.statSync(path).size).toBe(expectedBytes);
	});

	test("readTextPrefix walks chunks until the byte budget is exhausted", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/prefix.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			writer.writeLineSync("alpha\n");
			writer.writeLineSync("bravo\n");
			writer.writeLineSync("charlie\n");
		} finally {
			void writer.close();
		}

		// Cap mid-second-chunk; first chunk = 6B, take 4 of the second.
		const prefix = await storage.readTextPrefix(path, 10);
		expect(prefix).toBe("alpha\nbrav");
	});

	test("subsequent writeLineSync after readTextSync stays O(1) (chunks preserved)", () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/cont.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			writer.writeLineSync("first\n");
			writer.writeLineSync("second\n");
			// Materialise once — implementation must NOT cache the joined string
			// back into the entry, or subsequent appends collapse back to O(N).
			expect(storage.readTextSync(path)).toBe("first\nsecond\n");
			writer.writeLineSync("third\n");
			expect(storage.readTextSync(path)).toBe("first\nsecond\nthird\n");
			expect(storage.statSync(path).size).toBe(Buffer.byteLength("first\nsecond\nthird\n", "utf-8"));
		} finally {
			void writer.close();
		}
	});

	test("writeTextSync resets the chunks and byte counter (overwrite semantics)", () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/overwrite.jsonl";
		storage.writeTextSync(path, "abcdef");
		expect(storage.statSync(path).size).toBe(6);
		storage.writeTextSync(path, "xy");
		expect(storage.statSync(path).size).toBe(2);
		expect(storage.readTextSync(path)).toBe("xy");
	});
});
