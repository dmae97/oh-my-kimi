import { describe, expect, it } from "bun:test";
import { buildHarborEnv, collectForwardEnv, parseArgs } from "./runner";

describe("generic agent-arg / env passthrough", () => {
	it("forwards repeated --agent-arg as a JSON array the in-container agent can parse", () => {
		const cfg = parseArgs([
			"--model",
			"anthropic/claude-opus-4-8",
			"--agent-arg",
			"--reasoning-slide-model",
			"--agent-arg",
			"google/gemini-3.5-flash",
			"--agent-arg",
			"--reasoning-slide-turns",
			"--agent-arg",
			"3",
		]);
		expect(cfg.agentArgs).toEqual([
			"--reasoning-slide-model",
			"google/gemini-3.5-flash",
			"--reasoning-slide-turns",
			"3",
		]);

		const env = buildHarborEnv(cfg, "/tmp/models.yml", null, "test");
		expect(JSON.parse(env.OMP_BENCH_AGENT_ARGS ?? "[]")).toEqual(cfg.agentArgs);
	});

	it("omits OMP_BENCH_AGENT_ARGS when no --agent-arg was passed", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		const env = buildHarborEnv(cfg, "/tmp/models.yml", null, "test");
		expect(env.OMP_BENCH_AGENT_ARGS).toBeUndefined();
	});

	it("routes an explicit --providers entry alongside the model's own provider", () => {
		// The runner has no built-in concept of a "second model"; gateway routing
		// for any extra model introduced via --agent-arg must be declared
		// explicitly via --providers.
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8", "--providers", "google"]);
		const env = buildHarborEnv(cfg, "/tmp/models.yml", null, "test");
		expect(new Set(env.OMP_BENCH_GATEWAY_PROVIDERS?.split(","))).toEqual(new Set(["anthropic", "google"]));
	});

	it("collects explicit --env pairs, with an explicit value winning over a bare host-forwarded key", () => {
		const cfg = parseArgs([
			"--model",
			"anthropic/claude-opus-4-8",
			"--env",
			"SOME_FLAG=1",
			"--env",
			"OTHER=two words",
		]);
		const forwarded = collectForwardEnv(cfg);
		expect(forwarded.SOME_FLAG).toBe("1");
		expect(forwarded.OTHER).toBe("two words");
	});
});

describe("install modes", () => {
	it("defaults to source mode and publishes the mount contract to the agent", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		expect(cfg.install).toBe("source");
		const env = buildHarborEnv(cfg, "/tmp/models.yml", null, "test", {
			arch: "arm64",
			depsDir: "/tmp/deps",
			nodeModules: ["node_modules"],
		});
		expect(env.OMP_BENCH_INSTALL).toBe("source");
		expect(env.OMP_BENCH_SOURCE_DIR).toBe("/opt/omp/src");
		expect(env.OMP_BENCH_SOURCE_BUN).toBe("/opt/omp/bin/bun");
		expect(env.OMP_BENCH_SOURCE_ARCH).toBe("arm64");
	});

	it("omits source mount env when no mount was prepared (binary/local runs)", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8", "--install", "local"]);
		const env = buildHarborEnv(cfg, "/tmp/models.yml", "/tmp/omp.tgz", "test");
		expect(env.OMP_BENCH_INSTALL).toBe("local");
		expect(env.OMP_BENCH_SOURCE_DIR).toBeUndefined();
		expect(env.OMP_BENCH_SOURCE_ARCH).toBeUndefined();
	});

	it("--tarball implies a local (tarball) install", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8", "--tarball", "/tmp/omp.tgz"]);
		expect(cfg.install).toBe("local");
		expect(cfg.build).toBe(false);
	});
});

describe("parseArgs validation", () => {
	it("rejects an unknown flag", () => {
		expect(() => parseArgs(["--model", "anthropic/claude-opus-4-8", "--not-a-real-flag"])).toThrow(/unknown flag/);
	});

	it("defaults to a generic, dataset-agnostic jobs directory", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		expect(cfg.jobsDir.endsWith("/runs/harbor")).toBe(true);
	});
});
