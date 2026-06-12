import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { TempDir } from "../src/temp";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TempDir.remove retry", () => {
	it("retries async removal on Windows EBUSY before succeeding", async () => {
		const dir = await TempDir.create("@pi-utils-tempdir-retry-async-");
		let attempts = 0;
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		vi.spyOn(fsPromises, "rm").mockImplementation(async () => {
			attempts++;
			if (attempts < 2) {
				const err = new Error("EBUSY") as NodeJS.ErrnoException;
				err.code = "EBUSY";
				throw err;
			}
		});

		await dir.remove();

		expect(attempts).toBe(2);
	});

	it("retries sync removal on Windows EBUSY before succeeding", async () => {
		const dir = await TempDir.create("@pi-utils-tempdir-retry-sync-");
		let attempts = 0;
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		vi.spyOn(fs, "rmSync").mockImplementation(() => {
			attempts++;
			if (attempts < 2) {
				const err = new Error("EBUSY") as NodeJS.ErrnoException;
				err.code = "EBUSY";
				throw err;
			}
		});

		dir.removeSync();

		expect(attempts).toBe(2);
	});
});