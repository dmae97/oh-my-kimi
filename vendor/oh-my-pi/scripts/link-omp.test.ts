import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const linkScript = path.join(repoRoot, "scripts", "link-omp.sh");
const targetWrapper = path.join(repoRoot, "packages", "coding-agent", "scripts", "omp");
const tempDirs: string[] = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-link-"));
	tempDirs.push(dir);
	return dir;
}

function writeBunShim(dir: string, body: string) {
	const shimDir = path.join(dir, "shim");
	fs.mkdirSync(shimDir, { recursive: true });
	const shim = path.join(shimDir, "bun");
	fs.writeFileSync(shim, `#!/bin/sh\n${body}`);
	fs.chmodSync(shim, 0o755);
	return shimDir;
}

function runLinkScript(env: NodeJS.ProcessEnv) {
	return spawnSync("sh", [linkScript], {
		cwd: repoRoot,
		env,
		encoding: "utf8",
	});
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("scripts/link-omp.sh", () => {
	it("falls back to BUN_INSTALL/bin when bun cannot resolve the global bin", () => {
		const dir = makeTempDir();
		const bunInstall = path.join(dir, "bun-install");
		const shimDir = writeBunShim(
			dir,
			[
				'if [ "$1" = "pm" ] && [ "$2" = "-g" ] && [ "$3" = "bin" ]; then',
				"  echo 'error: No package.json was found for directory' >&2",
				"  exit 1",
				"fi",
				"exit 99",
				"",
			].join("\n"),
		);

		const result = runLinkScript({
			...process.env,
			HOME: path.join(dir, "home"),
			BUN_INSTALL: bunInstall,
			PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(fs.readlinkSync(path.join(bunInstall, "bin", "omp"))).toBe(targetWrapper);
	});

	it("uses bun pm -g bin when it succeeds", () => {
		const dir = makeTempDir();
		const globalBin = path.join(dir, "global-bin");
		const shimDir = writeBunShim(
			dir,
			[
				'if [ "$1" = "pm" ] && [ "$2" = "-g" ] && [ "$3" = "bin" ]; then',
				`  echo '${globalBin}'`,
				"  exit 0",
				"fi",
				"exit 99",
				"",
			].join("\n"),
		);

		const result = runLinkScript({
			...process.env,
			HOME: path.join(dir, "home"),
			BUN_INSTALL: path.join(dir, "unused-bun-install"),
			PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(fs.readlinkSync(path.join(globalBin, "omp"))).toBe(targetWrapper);
		expect(fs.existsSync(path.join(dir, "unused-bun-install", "bin", "omp"))).toBe(false);
	});
});
