import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildHarborEnv, collectForwardEnv, parseArgs, readTrials } from "./runner";

describe("generic agent-arg / env passthrough", () => {
	it("forwards repeated --agent-arg as a JSON array the in-container agent can parse", () => {
		const cfg = parseArgs([
			"--model",
			"anthropic/claude-opus-4-8",
			"--agent-arg",
			"--prewalk",
			"--agent-arg",
			"--prewalk-into",
			"--agent-arg",
			"google/gemini-3.5-flash",
		]);
		expect(cfg.agentArgs).toEqual(["--prewalk", "--prewalk-into", "google/gemini-3.5-flash"]);

		const env = buildHarborEnv(cfg, "/tmp/models.yml", null, "test");
		expect(JSON.parse(env.OMP_BENCH_AGENT_ARGS ?? "[]")).toEqual(cfg.agentArgs);
	});

	it("omits OMP_BENCH_AGENT_ARGS when no --agent-arg was passed", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		const env = buildHarborEnv(cfg, "/tmp/models.yml", null, "test");
		expect(env.OMP_BENCH_AGENT_ARGS).toBeUndefined();
	});

	it("explicit --providers is authoritative; the default derives from the model", () => {
		// Explicit list: exactly what was asked for — the escape hatch that lets
		// the model's own provider authenticate directly (forwarded env key)
		// while only e.g. oauth-only providers route through the gateway.
		const explicit = parseArgs(["--model", "anthropic/claude-opus-4-8", "--providers", "google"]);
		const envExplicit = buildHarborEnv(explicit, "/tmp/models.yml", null, "test");
		expect(new Set(envExplicit.OMP_BENCH_GATEWAY_PROVIDERS?.split(","))).toEqual(new Set(["google"]));
		// No flag: the model's provider is gateway-routed by default.
		const derived = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		const envDerived = buildHarborEnv(derived, "/tmp/models.yml", null, "test");
		expect(new Set(envDerived.OMP_BENCH_GATEWAY_PROVIDERS?.split(","))).toEqual(new Set(["anthropic"]));
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

describe("environment backends", () => {
	it("defaults to docker with the host.docker.internal gateway", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		expect(cfg.envType).toBe("docker");
		expect(cfg.gatewayUrl).toBe("http://host.docker.internal:4000");
	});

	it("apple-container swaps the default gateway host to the vmnet bridge address", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8", "--environment", "apple-container"]);
		expect(cfg.envType).toBe("apple-container");
		expect(cfg.gatewayUrl).toBe("http://192.168.64.1:4000");
	});

	it("an explicit --gateway-url wins over the apple-container default, regardless of flag order", () => {
		const cfg = parseArgs([
			"--model",
			"anthropic/claude-opus-4-8",
			"--gateway-url",
			"http://10.0.0.5:9999",
			"--environment",
			"apple-container",
		]);
		expect(cfg.gatewayUrl).toBe("http://10.0.0.5:9999");
	});

	it("rejects --host-network with apple-container (compose overlay is docker-only)", () => {
		expect(() =>
			parseArgs(["--model", "anthropic/claude-opus-4-8", "--environment", "apple-container", "--host-network"]),
		).toThrow(/docker-only/);
	});

	it("rejects an invalid --environment value", () => {
		expect(() => parseArgs(["--model", "anthropic/claude-opus-4-8", "--environment", "podman"])).toThrow(
			/--environment must be/,
		);
	});
});

describe("live-trial cost probe", () => {
	const usageEvent = (cost: number, input: number, output: number): string =>
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input, output, cacheRead: 0, cost: { total: cost } },
			},
		})}\n`;

	it("accumulates usage incrementally across appended transcript writes", () => {
		const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-runner-test-"));
		try {
			const agentDir = path.join(jobDir, "task__abc", "agent");
			fs.mkdirSync(agentDir, { recursive: true });
			const log = path.join(agentDir, "omp.txt");

			// First flush: one complete event plus a partial line mid-write.
			fs.writeFileSync(log, `${usageEvent(0.5, 100, 10)}{"type":"mess`);
			let [trial] = readTrials(jobDir);
			expect(trial.status).toBe("running");
			expect(trial.costUsd).toBeCloseTo(0.5);
			expect(trial.tokIn).toBe(100);

			// Second flush completes the partial line and appends another event.
			// Only appended bytes are parsed: the first event must count once.
			fs.appendFileSync(log, `age_end"}\n${usageEvent(0.25, 40, 4)}`);
			[trial] = readTrials(jobDir);
			expect(trial.costUsd).toBeCloseTo(0.75);
			expect(trial.tokIn).toBe(140);
			expect(trial.tokOut).toBe(14);
		} finally {
			fs.rmSync(jobDir, { recursive: true, force: true });
		}
	});
});
