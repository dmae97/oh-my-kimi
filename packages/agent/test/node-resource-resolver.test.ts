import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeResourceKeyResolver } from "../src/node-resource-resolver.ts";
import { scheduleDagLevels } from "../src/tool-dag-scheduler.ts";

describe("createNodeResourceKeyResolver (ALG002-A §5.5)", () => {
	let root: string;
	const resolver = createNodeResourceKeyResolver();

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "omk-node-resolver-")));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves an existing file to lexical, real, and dev:ino identity keys", async () => {
		const file = join(root, "a.ts");
		writeFileSync(file, "x");

		const keys = await resolver.resolvePath(file, root);
		expect(keys).not.toBeNull();
		expect(keys?.lexicalKey).toBe(file);
		expect(keys?.realKey).toBe(file);
		expect(keys?.inodeKey).toMatch(/^\d+:\d+$/);
	});

	it("resolves a relative path against the supplied cwd", async () => {
		writeFileSync(join(root, "a.ts"), "x");
		const keys = await resolver.resolvePath("./x/../a.ts", root);
		expect(keys?.lexicalKey).toBe(join(root, "a.ts"));
		expect(keys?.realKey).toBe(join(root, "a.ts"));
	});

	it("canonicalizes a POSIX triple-slash alias to the same identity", async () => {
		// Given: one existing file addressed with one or three leading slashes.
		const file = join(root, "triple.ts");
		writeFileSync(file, "x");

		// When: both aliases cross the Node identity boundary.
		const direct = await resolver.resolvePath(file, root);
		const aliased = await resolver.resolvePath(`//${file}`, root);

		// Then: lexical, realpath, and inode identities are identical.
		expect(aliased).toEqual(direct);
	});

	it("maps symlink aliases of the same file to one realKey", async () => {
		mkdirSync(join(root, "releases", "42"), { recursive: true });
		writeFileSync(join(root, "releases", "42", "a.ts"), "x");
		symlinkSync(join(root, "releases", "42"), join(root, "current"));

		const viaLink = await resolver.resolvePath(join(root, "current", "a.ts"), root);
		const direct = await resolver.resolvePath(join(root, "releases", "42", "a.ts"), root);
		expect(viaLink?.realKey).toBe(direct?.realKey);
		expect(viaLink?.inodeKey).toBe(direct?.inodeKey);
	});

	it("reattaches the non-existing suffix under the nearest existing ancestor realpath", async () => {
		mkdirSync(join(root, "real"), { recursive: true });
		symlinkSync(join(root, "real"), join(root, "link"));

		const keys = await resolver.resolvePath(join(root, "link", "new-dir", "new.ts"), root);
		expect(keys?.realKey).toBe(join(root, "real", "new-dir", "new.ts"));
		// A path that does not exist has no inode identity.
		expect(keys?.inodeKey).toBeUndefined();
	});

	it("maps a dangling symlink tail to its direct lexical target identity", async () => {
		// Given: a symlink whose target and requested suffix do not exist yet.
		const target = join(root, "future");
		const link = join(root, "dangling");
		symlinkSync(target, link);

		// When: the link tail and direct target tail are resolved.
		const viaLink = await resolver.resolvePath(join(link, "new.ts"), root);
		const direct = await resolver.resolvePath(join(target, "new.ts"), root);

		// Then: nearest-ancestor realpath plus lexical tail binds one identity.
		expect(viaLink?.realKey).toBe(direct?.realKey);
	});

	it("follows dangling symlink chains and normalizes absolute readlink slashes", async () => {
		const target = join(root, "future");
		const second = join(root, "second");
		const first = join(root, "first");
		symlinkSync(`//${target}`, second);
		symlinkSync(second, first);

		const viaChain = await resolver.resolvePath(join(first, "new.ts"), root);
		const direct = await resolver.resolvePath(join(target, "new.ts"), root);
		expect(viaChain?.realKey).toBe(direct?.realKey);
	});

	it("bounds dangling symlink cycles and over-depth chains", async () => {
		const cycleA = join(root, "cycle-a");
		const cycleB = join(root, "cycle-b");
		symlinkSync(cycleB, cycleA);
		symlinkSync(cycleA, cycleB);
		expect((await resolver.resolvePath(join(cycleA, "new.ts"), root))?.realKey).toBeUndefined();

		for (let index = 0; index < 47; index++) {
			symlinkSync(join(root, `deep-${index + 1}`), join(root, `deep-${index}`));
		}
		symlinkSync(join(root, "deep-target"), join(root, "deep-47"));
		expect((await resolver.resolvePath(join(root, "deep-0", "new.ts"), root))?.realKey).toBeUndefined();
	});

	it("gives hardlinked names the same dev:ino identity key", async () => {
		const original = join(root, "hardlink-a");
		const alias = join(root, "hardlink-b");
		writeFileSync(original, "x");
		linkSync(original, alias);

		const a = await resolver.resolvePath(original, root);
		const b = await resolver.resolvePath(alias, root);
		expect(a?.inodeKey).toBeDefined();
		expect(a?.inodeKey).toBe(b?.inodeKey);
		// Distinct directory entries keep distinct real keys.
		expect(a?.realKey).not.toBe(b?.realKey);
	});

	it("expands a leading tilde using the injected home directory", async () => {
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "a.ts"), "x");
		const tildeResolver = createNodeResourceKeyResolver({ homedir: () => home });

		const keys = await tildeResolver.resolvePath("~/a.ts", root);
		expect(keys?.lexicalKey).toBe(join(home, "a.ts"));
		expect(keys?.realKey).toBe(join(home, "a.ts"));
	});

	it("fails UNC identities exclusive when this resolver cannot filesystem-resolve them", async () => {
		expect(await resolver.resolvePath("\\\\Server\\Share\\a.ts", root)).toBeNull();
		expect(await resolver.resolvePath("//server/share/a.ts", root)).toBeNull();
	});

	it("fails Windows drive identities exclusive when this resolver cannot filesystem-resolve them", async () => {
		expect(await resolver.resolvePath("C:\\Repo\\a.ts", root)).toBeNull();
		expect(await resolver.resolvePath("c:/Repo/a.ts", root)).toBeNull();
	});

	it("fails closed to null for root-escaping and empty paths", async () => {
		expect(await resolver.resolvePath("../".repeat(64), "/")).toBeNull();
		expect(await resolver.resolvePath("", root)).toBeNull();
		expect(await resolver.resolvePath("   ", root)).toBeNull();
	});

	it("falls back to the lexical key when filesystem identity resolution fails", async () => {
		const failing = createNodeResourceKeyResolver({
			realpath: async () => {
				throw new Error("EACCES");
			},
		});
		const file = join(root, "a.ts");
		writeFileSync(file, "x");
		const keys = await failing.resolvePath(file, root);
		expect(keys?.lexicalKey).toBe(file);
		expect(keys?.realKey).toBeUndefined();
		expect(keys?.inodeKey).toBeUndefined();
	});

	it("serializes a tilde path with its absolute home alias in the production DAG", async () => {
		const home = join(root, "home");
		mkdirSync(home);
		writeFileSync(join(home, "a.ts"), "x");
		const homeResolver = createNodeResourceKeyResolver({ homedir: () => home });

		const plan = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: "~/a.ts" } },
				{ name: "read", arguments: { path: join(home, "a.ts") } },
				{ name: "write", arguments: { path: join(root, "other.ts") } },
			],
			{ cwd: root, resourceKeyResolver: homeResolver },
		);

		expect(plan.levels).toEqual([[0, 2], [1]]);
	});

	it("serializes symlink and hardlink aliases in the production DAG", async () => {
		const target = join(root, "target.ts");
		const symlink = join(root, "symlink.ts");
		const hardlink = join(root, "hardlink.ts");
		writeFileSync(target, "x");
		symlinkSync(target, symlink);
		linkSync(target, hardlink);

		const plan = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: symlink } },
				{ name: "write", arguments: { path: hardlink } },
				{ name: "write", arguments: { path: join(root, "other.ts") } },
				{ name: "read", arguments: { path: target } },
			],
			{ cwd: root, resourceKeyResolver: resolver },
		);

		expect(plan.levels).toEqual([[0, 2], [1], [3]]);
	});

	it.each([
		{
			name: "UNC",
			paths: ["\\\\Server\\Share\\Repo\\a.ts", "//server/share/repo/A.ts", "//server/share/other.ts"],
		},
		{
			name: "drive-letter",
			paths: ["C:\\Repo\\a.ts", "c:/repo/A.ts", "D:/repo/a.ts"],
		},
	])("isolates every unresolved $name identity in the production DAG", async ({ paths }) => {
		const plan = await scheduleDagLevels(
			paths.map((path) => ({ name: "write", arguments: { path } })),
			{ cwd: root, resourceKeyResolver: resolver },
		);

		expect(plan.levels).toEqual([[0], [1], [2]]);
	});

	it.each([
		{
			name: "throws",
			resolver: {
				resolvePath: () => {
					throw new Error("resolver failed");
				},
			},
		},
		{
			name: "rejects",
			resolver: { resolvePath: async () => Promise.reject(new Error("resolver failed")) },
		},
		{
			name: "returns null",
			resolver: { resolvePath: () => null },
		},
	])("fails closed when the production resource resolver $name", async ({ resolver: failingResolver }) => {
		const plan = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: join(root, "a.ts") } },
				{ name: "write", arguments: { path: join(root, "b.ts") } },
				{ name: "write", arguments: { path: join(root, "c.ts") } },
			],
			{ cwd: root, resourceKeyResolver: failingResolver },
		);

		expect(plan.levels).toEqual([[0], [1], [2]]);
	});
});
