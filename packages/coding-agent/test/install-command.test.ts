/**
 * Regression test for #1496 (bug 2): `omp install ./my-extension` used to be
 * silently rewritten to `launch install ./my-extension` and forwarded to the
 * LLM as an initial prompt because no top-level `install` subcommand existed.
 *
 * These tests pin two invariants:
 *
 *  1. `install` is registered in the CLI command table, so the runner does
 *     not prepend `launch` and the args never reach the model.
 *  2. The local-path heuristic that routes `install ./foo` to `plugin link`
 *     while routing remote specs to `plugin install` is correct for the
 *     shapes users actually type.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { looksLikeLocalPath } from "@oh-my-pi/pi-coding-agent/commands/install";

describe("install command is registered as a top-level subcommand", () => {
	test("CLI runner sees `install` as a known command", async () => {
		const cli = await import("@oh-my-pi/pi-coding-agent/cli-commands");
		expect(cli.commands.some(c => c.name === "install")).toBe(true);
		expect(cli.isSubcommand("install")).toBe(true);
	});
});

describe("looksLikeLocalPath", () => {
	test("explicit relative paths are local", () => {
		expect(looksLikeLocalPath("./my-extension")).toBe(true);
		expect(looksLikeLocalPath("../sibling")).toBe(true);
		expect(looksLikeLocalPath(".")).toBe(true);
	});

	test("absolute and home-relative paths are local", () => {
		expect(looksLikeLocalPath("/usr/local/share/ext")).toBe(true);
		expect(looksLikeLocalPath("~/extensions/foo")).toBe(true);
	});

	test("Windows drive-prefixed paths are local", () => {
		expect(looksLikeLocalPath("C:\\extensions\\foo")).toBe(true);
		expect(looksLikeLocalPath("D:/extensions/foo")).toBe(true);
	});

	test("npm specs and marketplace refs are remote", () => {
		expect(looksLikeLocalPath("@oh-my-pi/exa")).toBe(false);
		expect(looksLikeLocalPath("my-pkg")).toBe(false);
		expect(looksLikeLocalPath("my-pkg@1.2.3")).toBe(false);
		expect(looksLikeLocalPath("name@marketplace")).toBe(false);
	});

	test("bare names that exist as a local directory are treated as local", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-install-test-"));
		const cwd = process.cwd();
		try {
			process.chdir(tempDir);
			fs.mkdirSync(path.join(tempDir, "vendored-ext"));
			expect(looksLikeLocalPath("vendored-ext")).toBe(true);
			expect(looksLikeLocalPath("missing-pkg")).toBe(false);
		} finally {
			process.chdir(cwd);
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
