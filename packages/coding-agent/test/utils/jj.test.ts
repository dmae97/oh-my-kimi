import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as jj from "../../src/utils/jj";

describe("jj workspace detection", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		jj.repo.clearRootCache();
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	async function createTempDir(): Promise<string> {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-utils-"));
		return tmpDir;
	}

	it("finds JJ workspace metadata from a nested cwd", async () => {
		const dir = await createTempDir();
		const nested = path.join(dir, "packages", "coding-agent");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(nested, { recursive: true });

		expect(await jj.repo.root(nested)).toBe(dir);
		expect(await jj.repo.is(nested)).toBe(true);
	});

	it("caches each requested cwd to its resolved workspace root", async () => {
		const dir = await createTempDir();
		const nested = path.join(dir, "src", "feature");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(nested, { recursive: true });

		expect(await jj.repo.root(nested)).toBe(dir);
		await fs.rm(path.join(dir, ".jj"), { recursive: true, force: true });

		expect(await jj.repo.root(nested)).toBe(dir);
		expect(await jj.repo.root(path.join(dir, "src"))).toBeNull();
	});

	it("does not treat a bare .jj directory as a workspace", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, ".jj"), { recursive: true });

		expect(await jj.repo.root(dir)).toBeNull();
		expect(await jj.repo.is(dir)).toBe(false);
	});
});
