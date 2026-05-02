import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { head } from "@oh-my-pi/pi-coding-agent/utils/git";

function makeEintrError(targetPath: string): NodeJS.ErrnoException {
	const err = new Error(`EINTR: interrupted system call, open '${targetPath}'`) as NodeJS.ErrnoException;
	err.code = "EINTR";
	err.errno = -4;
	err.syscall = "open";
	err.path = targetPath;
	return err;
}

describe("issue #899 — sync git metadata reads must survive EINTR", () => {
	let tempDir: string;
	let headPath: string;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "issue-899-"));
		const gitDir = path.join(tempDir, ".git");
		await fsp.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
		await fsp.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		await fsp.writeFile(path.join(gitDir, "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n");
		headPath = path.join(gitDir, "HEAD");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	test("head.resolveSync does not throw when .git/HEAD read hits EINTR", () => {
		const realReadFileSync = fs.readFileSync;
		const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
			filePath: fs.PathOrFileDescriptor,
			options?: unknown,
		) => {
			if (typeof filePath === "string" && filePath === headPath) {
				throw makeEintrError(headPath);
			}
			return (realReadFileSync as (p: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer)(filePath, options);
		}) as typeof fs.readFileSync);

		// On main this throws EINTR; after fix it must return null (metadata unavailable).
		expect(() => head.resolveSync(tempDir)).not.toThrow();
		expect(head.resolveSync(tempDir)).toBeNull();
		expect(spy).toHaveBeenCalled();
	});

	test("head.resolveSync recovers from a transient EINTR via bounded retry", () => {
		const realReadFileSync = fs.readFileSync;
		let headReads = 0;
		vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: unknown) => {
			if (typeof filePath === "string" && filePath === headPath) {
				headReads += 1;
				if (headReads === 1) throw makeEintrError(headPath);
			}
			return (realReadFileSync as (p: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer)(filePath, options);
		}) as typeof fs.readFileSync);

		const state = head.resolveSync(tempDir);
		expect(state).not.toBeNull();
		expect(state?.kind).toBe("ref");
		if (state?.kind === "ref") expect(state.branchName).toBe("main");
		expect(headReads).toBeGreaterThanOrEqual(2);
	});
});
