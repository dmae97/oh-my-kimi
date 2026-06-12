import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";

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

	it("detects a non-default workspace whose .jj/repo is a file", async () => {
		const dir = await createTempDir();
		const secondary = path.join(dir, "ws2");
		// Default workspace: `.jj/repo/` is a directory containing the store.
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		// `jj workspace add` workspace: `.jj/repo` is a FILE pointing — relative to
		// `.jj` — at the shared repo dir of the default workspace.
		await fs.mkdir(path.join(secondary, ".jj", "working_copy"), { recursive: true });
		await fs.writeFile(path.join(secondary, ".jj", "repo"), path.join("..", "..", ".jj", "repo"));

		expect(await jj.repo.is(secondary)).toBe(true);
		expect(await jj.repo.root(secondary)).toBe(secondary);
	});

	it("resolves storeDir to the shared store for a non-default workspace", async () => {
		const dir = await createTempDir();
		const secondary = path.join(dir, "ws2");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(path.join(secondary, ".jj", "working_copy"), { recursive: true });
		await fs.writeFile(path.join(secondary, ".jj", "repo"), path.join("..", "..", ".jj", "repo"));

		const resolved = await jj.repo.resolve(secondary);
		expect(resolved?.repoRoot).toBe(secondary);
		expect(resolved?.storeDir).toBe(path.join(dir, ".jj", "repo", "store"));
	});
});
