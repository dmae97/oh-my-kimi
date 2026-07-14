import { describe, expect, it, spyOn } from "bun:test";
import { Args, Command, type CommandEntry, Flags, run } from "../src/cli";

class GoodCommand extends Command {
	static description = "prints good things";
	static flags = {
		verbose: Flags.boolean({ description: "be loud" }),
	};
	async run(): Promise<void> {}
}

class BenchLikeCommand extends Command {
	static description = "benchmark models";
	static args = {
		models: Args.string({ description: "model selectors", required: true, multiple: true }),
	};
	static flags = {
		runs: Flags.integer({ description: "requests per model", default: 10 }),
	};
	async run(): Promise<void> {
		await this.parse(BenchLikeCommand);
	}
}

describe("run() per-command help", () => {
	// Contract: `omp <cmd> --help` must load only the requested command module.
	// Loading the whole table would let any unrelated command whose import
	// hangs or crashes take down every per-command help invocation.
	it("loads only the requested command", async () => {
		let brokenLoads = 0;
		const commands: CommandEntry[] = [
			{ name: "good", load: async () => GoodCommand },
			{
				name: "broken",
				load: async () => {
					brokenLoads++;
					throw new Error("import-time crash");
				},
			},
		];
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			await run({ bin: "omp", version: "0.0.0", argv: ["good", "--help"], commands });
		} finally {
			stdoutSpy.mockRestore();
		}
		expect(brokenLoads).toBe(0);
		expect(writes.join("")).toContain("prints good things");
		expect(writes.join("")).toContain("--verbose");
	});
});

describe("run() usage errors", () => {
	// Contract: a missing required arg prints a concise `error:` + USAGE line to
	// stderr and exits 1 — it must NOT throw past run() (which would dump a
	// minified `dist/cli.js` code frame). Regression for #5369.
	it("prints a concise usage error instead of throwing on a missing required arg", async () => {
		const commands: CommandEntry[] = [{ name: "bench", load: async () => BenchLikeCommand }];
		const errs: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
			errs.push(String(chunk));
			return true;
		});
		const prevExitCode = process.exitCode;
		try {
			await expect(run({ bin: "omp", version: "0.0.0", argv: ["bench"], commands })).resolves.toBeUndefined();
		} finally {
			stderrSpy.mockRestore();
			process.exitCode = prevExitCode ?? 0;
		}
		const out = errs.join("");
		expect(out).toContain("error: Missing required argument: models");
		expect(out).toContain("$ omp bench MODELS... [FLAGS]");
		expect(out).not.toContain("dist/cli.js");
	});

	// Contract: `--help` USAGE renders a required variadic as `MODELS...`, never
	// the misleading optional `[MODELS]`. Regression for #5369.
	it("renders a required variadic arg without optional brackets", async () => {
		const commands: CommandEntry[] = [{ name: "bench", load: async () => BenchLikeCommand }];
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			await run({ bin: "omp", version: "0.0.0", argv: ["bench", "--help"], commands });
		} finally {
			stdoutSpy.mockRestore();
		}
		const out = writes.join("");
		expect(out).toContain("$ omp bench MODELS... [FLAGS]");
		expect(out).not.toContain("[MODELS]");
	});

	it("prints a concise usage error for an unknown flag", async () => {
		const commands: CommandEntry[] = [{ name: "bench", load: async () => BenchLikeCommand }];
		const errs: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
			errs.push(String(chunk));
			return true;
		});
		const prevExitCode = process.exitCode;
		try {
			await expect(
				run({ bin: "omp", version: "0.0.0", argv: ["bench", "--unknown"], commands }),
			).resolves.toBeUndefined();
		} finally {
			stderrSpy.mockRestore();
			process.exitCode = prevExitCode ?? 0;
		}
		const out = errs.join("");
		expect(out).toContain("error: Unknown option '--unknown'");
		expect(out).toContain("$ omp bench MODELS... [FLAGS]");
	});
});
