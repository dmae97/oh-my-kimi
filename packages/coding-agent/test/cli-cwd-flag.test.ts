import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { parseArgs } from "../src/cli/args";
import { applyStartupCwd } from "../src/cli/startup-cwd";

const originalProjectDir = getProjectDir();

afterEach(() => {
	setProjectDir(originalProjectDir);
});
describe("parseArgs — --cwd flag", () => {
	it("parses --cwd with a space-separated directory", () => {
		const result = parseArgs(["--cwd", "/work/project", "hello"]);

		expect(result.cwd).toBe("/work/project");
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --cwd=value without leaking the value into messages", () => {
		const result = parseArgs(["--cwd=/work/project", "hello"]);

		expect(result.cwd).toBe("/work/project");
		expect(result.messages).toEqual(["hello"]);
	});

	it("applies --cwd before session lookup callers read the project directory", async () => {
		const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-launch-"));
		const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-target-"));
		setProjectDir(launchDir);

		const parsed = parseArgs(["--cwd", targetDir, "--continue"]);
		await applyStartupCwd(parsed);

		expect(parsed.continue).toBe(true);
		expect(getProjectDir()).toBe(targetDir);
		expect(process.cwd()).toBe(targetDir);
	});
});
