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

async function runProbeScenario(options: {
	runs: number;
	sleepSeconds?: number;
	holdStdoutOpen?: boolean;
	descendantHoldsStdout?: boolean;
	validOutput?: string;
}): Promise<ProbeRunResult> {
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
			'#!/usr/bin/env sh\nprintf x >> "$OMP_GPU_PROBE_COUNT"\nif [ -n "$OMP_GPU_PROBE_VALID_OUTPUT" ]; then printf "%s\\n" "$OMP_GPU_PROBE_VALID_OUTPUT"; fi\nif [ "$OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT" = "true" ]; then sleep "$OMP_GPU_PROBE_SLEEP" & exit 0; fi\nif [ "$OMP_GPU_PROBE_HOLD_STDOUT_OPEN" = "true" ]; then sleep "$OMP_GPU_PROBE_SLEEP" & wait "$!"; fi\nif [ -n "$OMP_GPU_PROBE_SLEEP" ]; then exec sleep "$OMP_GPU_PROBE_SLEEP"; fi\nexit 0\n',
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
		if (options.holdStdoutOpen) {
			env.OMP_GPU_PROBE_HOLD_STDOUT_OPEN = "true";
		} else {
			delete env.OMP_GPU_PROBE_HOLD_STDOUT_OPEN;
		}
		if (options.descendantHoldsStdout) {
			env.OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT = "true";
		} else {
			delete env.OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT;
		}
		if (options.validOutput !== undefined) {
			env.OMP_GPU_PROBE_VALID_OUTPUT = options.validOutput;
		} else {
			delete env.OMP_GPU_PROBE_VALID_OUTPUT;
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
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 7, holdStdoutOpen: true });

		expect(result.cached).toEqual({ gpu: null });
		expect(result.elapsedMs).toBeLessThan(6500);
		// Codex#3838: the child process MUST exit shortly after the deadline,
		// not linger until a descendant holding stdout (sleep 7) exits on its own.
		expect(result.childElapsedMs).toBeLessThan(6500);
	}, 15_000);

	it("does not wait on stdout held by a descendant after a successful probe", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 3, descendantHoldsStdout: true });

		expect(result.cached).toEqual({ gpu: null });
		// Probe exits 0 immediately but leaves a backgrounded sleep holding the stdout
		// pipe. The success path MUST bound the drain wait, not block until sleep exits.
		expect(result.elapsedMs).toBeLessThan(2000);
		expect(result.childElapsedMs).toBeLessThan(2000);
	}, 15_000);

	it("keeps probe output captured before a descendant delays EOF", async () => {
		const result = await runProbeScenario({
			runs: 1,
			sleepSeconds: 3,
			descendantHoldsStdout: true,
			validOutput: "00:02.0 VGA compatible controller: NVIDIA TestGPU",
		});

		// Probe exited 0 with valid output before bg sleep held stdout open.
		// Captured stdout MUST be cached, not discarded as if the probe failed.
		expect(result.cached).toEqual({ gpu: "02.0 VGA compatible controller: NVIDIA TestGPU" });
		expect(result.elapsedMs).toBeLessThan(2000);
		expect(result.childElapsedMs).toBeLessThan(2000);
	}, 15_000);
});
