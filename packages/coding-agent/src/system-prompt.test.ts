import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface ProbeRunResult {
	elapsedMs: number;
	childElapsedMs: number;
	cached: unknown;
	count: number;
}

async function runProbeScenario(options: { runs: number; sleepSeconds?: number }): Promise<ProbeRunResult> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gpu-probe-"));
	try {
		const binDir = path.join(tempRoot, "bin");
		const cacheRoot = path.join(tempRoot, "cache");
		const probeCountPath = path.join(tempRoot, "probe-count");
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(path.join(cacheRoot, "omp"), { recursive: true });
		const lspciPath = path.join(binDir, "lspci");
		await Bun.write(
			lspciPath,
			'#!/usr/bin/env sh\nprintf x >> "$OMP_GPU_PROBE_COUNT"\nif [ -n "$OMP_GPU_PROBE_SLEEP" ]; then exec sleep "$OMP_GPU_PROBE_SLEEP"; fi\nexit 0\n',
		);
		await fs.chmod(lspciPath, 0o755);

		const scenarioPath = path.join(tempRoot, "scenario.ts");
		await Bun.write(
			scenarioPath,
			`import { getGpuCachePath, refreshDirsFromEnv } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/index.ts"))};
import { buildSystemPrompt } from ${JSON.stringify(path.join(import.meta.dir, "system-prompt.ts"))};

refreshDirsFromEnv();
const buildOptions = {
	contextFiles: [],
	skills: [],
	toolNames: [],
	workspaceTree: {
		rootPath: process.cwd(),
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [],
	},
	activeRepoContext: null,
};
const startedAt = performance.now();
for (let index = 0; index < Number(process.env.OMP_GPU_PROBE_RUNS ?? "1"); index += 1) {
	await buildSystemPrompt(buildOptions);
}
const cacheFile = Bun.file(getGpuCachePath());
const cached = await cacheFile.exists() ? await cacheFile.json() : null;
const countFile = Bun.file(process.env.OMP_GPU_PROBE_COUNT ?? "");
const count = await countFile.exists() ? (await countFile.text()).length : 0;
console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - startedAt), cached, count }));
`,
		);

		const env: Record<string, string | undefined> = {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			XDG_CACHE_HOME: cacheRoot,
			OMP_GPU_PROBE_COUNT: probeCountPath,
			OMP_GPU_PROBE_RUNS: String(options.runs),
		};
		// Strip inherited dirs-resolver overrides so XDG_CACHE_HOME above wins and
		// the test cannot touch the developer/CI profile's real gpu_cache.json.
		for (const key of ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"]) {
			delete env[key];
		}
		if (options.sleepSeconds === undefined) {
			delete env.OMP_GPU_PROBE_SLEEP;
		} else {
			env.OMP_GPU_PROBE_SLEEP = String(options.sleepSeconds);
		}

		const childStartedAt = performance.now();
		const child = Bun.spawn([process.execPath, scenarioPath], { stdout: "pipe", stderr: "pipe", env });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const childElapsedMs = Math.round(performance.now() - childStartedAt);
		if (exitCode !== 0) {
			throw new Error(`GPU probe scenario failed with exit ${exitCode}: ${stderr}`);
		}
		return { ...JSON.parse(stdout.trim()), childElapsedMs };
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform !== "linux")("system prompt GPU probe", () => {
	it("caches empty GPU probe results", async () => {
		const result = await runProbeScenario({ runs: 2 });

		expect(result.cached).toEqual({ gpu: null });
		expect(result.count).toBe(1);
	}, 15_000);

	it("kills the GPU probe at the prep deadline", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 7 });

		expect(result.elapsedMs).toBeLessThan(6500);
		// Codex#3838: the child process MUST exit shortly after the deadline,
		// not linger until the underlying probe (sleep 7) finishes on its own.
		expect(result.childElapsedMs).toBeLessThan(6500);
	}, 15_000);
});
