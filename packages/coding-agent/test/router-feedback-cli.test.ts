import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRouterFeedbackCli } from "../src/commands/router-feedback-cli.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { parseRouterBiasSnapshot } from "../src/core/reasoning-router-bias.ts";
import { getRepositoryRouterLearningPaths } from "../src/core/repository-learning-scope.ts";
import type { RouterFeedbackRecord } from "../src/core/router-feedback-collector.ts";

function overrideRecord(): RouterFeedbackRecord {
	return {
		routerVersion: "v4",
		laneType: "none",
		predictedClass: "simple-edit",
		resolvedLevel: "low",
		acceptedLevel: "medium",
		signal: "s1-override",
		outcome: "up",
		lenBucket: 1,
		hadFence: false,
		hadDiff: false,
	};
}

describe("omk router-feedback compile-bias CLI", () => {
	let dir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "omk-router-feedback-cli-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	it("ignores unrelated argv and refuses incomplete or unknown commands", () => {
		expect(runRouterFeedbackCli(["stats"])).toEqual({ handled: false, exitCode: 0 });

		const out: string[] = [];
		expect(runRouterFeedbackCli(["router-feedback"], { writeLine: (line) => out.push(line) })).toEqual({
			handled: true,
			exitCode: 2,
		});
		expect(
			runRouterFeedbackCli(["router-feedback", "compile-bias", "--nope"], { writeLine: (line) => out.push(line) }),
		).toEqual({
			handled: true,
			exitCode: 2,
		});
		expect(
			runRouterFeedbackCli(["router-feedback", "compile-bias", "--out", ""], {
				writeLine: (line) => out.push(line),
			}),
		).toEqual({ handled: true, exitCode: 2 });
		expect(out.every((line) => JSON.parse(line).status === "refused")).toBe(true);
	});

	it("prints help without compiling", () => {
		const out: string[] = [];
		expect(
			runRouterFeedbackCli(["router-feedback", "compile-bias", "--help"], {
				writeLine: (line) => out.push(line),
			}),
		).toEqual({ handled: true, exitCode: 0 });
		expect(out).toEqual(["Usage: omk router-feedback compile-bias [--cwd <dir>] [--ledger <path>] [--out <path>]"]);
	});

	it("uses repository-scoped defaults and writes a private empty snapshot", () => {
		const repository = join(dir, "repository");
		const nested = join(repository, "src");
		mkdirSync(join(repository, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		const paths = getRepositoryRouterLearningPaths(nested, process.env[ENV_AGENT_DIR]);

		const out: string[] = [];
		expect(
			runRouterFeedbackCli(["router-feedback", "compile-bias", "--cwd", nested], {
				writeLine: (line) => out.push(line),
			}),
		).toEqual({ handled: true, exitCode: 0 });

		const snapshot = parseRouterBiasSnapshot(readFileSync(paths.biasSnapshotPath, "utf8"));
		expect(snapshot).not.toBeNull();
		expect(snapshot?.consideredCount).toBe(0);
		expect(snapshot?.biasCells).toEqual([]);
		expect(statSync(paths.biasSnapshotPath).mode & 0o777).toBe(0o600);
		expect(out[0]).toContain("considered=0");
	});

	it("honors explicit paths, skips malformed lines, and compiles deterministically", () => {
		const ledgerPath = join(dir, "custom", "ledger.jsonl");
		const outPath = join(dir, "custom", "snapshot.json");
		mkdirSync(join(dir, "custom"), { recursive: true });
		const line = JSON.stringify(overrideRecord());
		writeFileSync(ledgerPath, `${Array.from({ length: 5 }, () => line).join("\n")}\nnot-json\n`, "utf8");
		const output: string[] = [];
		const args = [
			"router-feedback",
			"compile-bias",
			"--cwd",
			join(dir, "unrelated"),
			"--ledger",
			ledgerPath,
			"--out",
			outPath,
		];

		expect(runRouterFeedbackCli(args, { writeLine: (entry) => output.push(entry) })).toEqual({
			handled: true,
			exitCode: 0,
		});
		const first = readFileSync(outPath, "utf8");
		const snapshot = parseRouterBiasSnapshot(first);
		expect(snapshot?.consideredCount).toBe(5);
		expect(snapshot?.biasCells).toHaveLength(1);
		expect(output[0]).toContain("parseErrors=1");

		chmodSync(outPath, 0o644);
		expect(runRouterFeedbackCli(args, { writeLine: () => undefined }).exitCode).toBe(0);
		expect(readFileSync(outPath, "utf8")).toBe(first);
		expect(statSync(outPath).mode & 0o777).toBe(0o600);
	});

	it("does not follow the predictable legacy temp-path symlink", () => {
		if (process.platform === "win32") return;
		const outPath = join(dir, "snapshot.json");
		const victimPath = join(dir, "victim.txt");
		const predictableTempPath = `${outPath}.${process.pid}.tmp`;
		writeFileSync(victimPath, "sentinel", "utf8");
		symlinkSync(victimPath, predictableTempPath);

		const result = runRouterFeedbackCli(["router-feedback", "compile-bias", "--out", outPath], {
			writeLine: () => undefined,
		});

		expect(result).toEqual({ handled: true, exitCode: 0 });
		expect(readFileSync(victimPath, "utf8")).toBe("sentinel");
		expect(parseRouterBiasSnapshot(readFileSync(outPath, "utf8"))).not.toBeNull();
	});

	it("returns exit code 1 instead of starting a session when writing fails", () => {
		const out: string[] = [];
		const result = runRouterFeedbackCli(["router-feedback", "compile-bias", "--out", dir], {
			writeLine: (line) => out.push(line),
		});
		expect(result).toEqual({ handled: true, exitCode: 1 });
		expect(JSON.parse(out[0])).toMatchObject({ status: "error" });
	});
});
