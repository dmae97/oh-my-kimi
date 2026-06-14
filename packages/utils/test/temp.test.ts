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

	it("gives up after the retry bound and rethrows the original error", async () => {
		const dir = await TempDir.create("@pi-utils-tempdir-retry-bound-");
		let attempts = 0;
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		vi.spyOn(fsPromises, "rm").mockImplementation(async () => {
			attempts++;
			const err = new Error("EBUSY") as NodeJS.ErrnoException;
			err.code = "EBUSY";
			throw err;
		});

		await expect(dir.remove()).rejects.toMatchObject({ code: "EBUSY" });
		// 1 initial attempt + 4 bounded retries, then surface the failure instead of looping forever.
		expect(attempts).toBe(5);

		vi.restoreAllMocks();
		fs.rmSync(dir.path(), { recursive: true, force: true });
	});

	it("does not retry non-transient removal errors", async () => {
		const dir = await TempDir.create("@pi-utils-tempdir-retry-nontransient-");
		let attempts = 0;
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		vi.spyOn(fsPromises, "rm").mockImplementation(async () => {
			attempts++;
			const err = new Error("EACCES") as NodeJS.ErrnoException;
			err.code = "EACCES";
			throw err;
		});

		await expect(dir.remove()).rejects.toMatchObject({ code: "EACCES" });
		expect(attempts).toBe(1);

		vi.restoreAllMocks();
		fs.rmSync(dir.path(), { recursive: true, force: true });
	});

	it("does not retry off Windows even for EBUSY", async () => {
		const dir = await TempDir.create("@pi-utils-tempdir-retry-nonwin-");
		let attempts = 0;
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		vi.spyOn(fsPromises, "rm").mockImplementation(async () => {
			attempts++;
			const err = new Error("EBUSY") as NodeJS.ErrnoException;
			err.code = "EBUSY";
			throw err;
		});

		await expect(dir.remove()).rejects.toMatchObject({ code: "EBUSY" });
		expect(attempts).toBe(1);

		vi.restoreAllMocks();
		fs.rmSync(dir.path(), { recursive: true, force: true });
	});
});
