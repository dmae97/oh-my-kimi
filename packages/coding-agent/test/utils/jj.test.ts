import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearWorkspaceRootCache, isRepository, workspaceRoot } from "../../src/utils/jj";

describe("jj workspace detection", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		clearWorkspaceRootCache();
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

		expect(await workspaceRoot(nested)).toBe(dir);
		expect(await isRepository(nested)).toBe(true);
	});

	it("caches each requested cwd to its resolved workspace root", async () => {
		const dir = await createTempDir();
		const nested = path.join(dir, "src", "feature");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(nested, { recursive: true });

		expect(await workspaceRoot(nested)).toBe(dir);
		await fs.rm(path.join(dir, ".jj"), { recursive: true, force: true });

		expect(await workspaceRoot(nested)).toBe(dir);
		expect(await workspaceRoot(path.join(dir, "src"))).toBeUndefined();
	});

	it("does not treat a bare .jj directory as a workspace", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, ".jj"), { recursive: true });

		expect(await workspaceRoot(dir)).toBeUndefined();
		expect(await isRepository(dir)).toBe(false);
	});
});
