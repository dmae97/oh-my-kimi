import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProviderDoctorResult, ProviderDoctorTransport } from "../src/commands/doctor-provider.ts";
import { runDoctorProviderCli } from "../src/commands/doctor-provider-cli.ts";

const SENTINEL = "cli-secret-sentinel";

function sequenceTransport(statuses: readonly number[]): ProviderDoctorTransport {
	let index = 0;
	return {
		pinsResolvedAddress: true,
		async request() {
			return { status: statuses[index++] ?? 500 };
		},
	};
}

function materializingTransport(statuses: readonly number[], captured: Headers[]): ProviderDoctorTransport {
	let index = 0;
	return {
		pinsResolvedAddress: true,
		async request(request) {
			captured.push(await request.createHeaders());
			return { status: statuses[index++] ?? 500 };
		},
	};
}

describe("provider doctor CLI", () => {
	let agentDir: string;
	let lines: string[];
	const writeLine = (line: string): void => {
		lines.push(line);
	};

	const parseOutput = (): ProviderDoctorResult => JSON.parse(lines.join("\n")) as ProviderDoctorResult;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "omk-doctor-cli-"));
		lines = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	test("is not handled when --doctor-provider is absent", async () => {
		for (const args of [[], ["hello world"], ["--model", "openai/gpt"], ["--doctor-providerish"]]) {
			const outcome = await runDoctorProviderCli(args, { agentDir, writeLine });
			expect(outcome.handled).toBe(false);
		}
		expect(lines).toHaveLength(0);
	});

	test("is not handled for provider-like args that are not the doctor subcommand", async () => {
		for (const args of [["provider"], ["provider", "list"], ["doctor", "provider"], ["providers", "doctor", "x"]]) {
			const outcome = await runDoctorProviderCli(args, { agentDir, writeLine });
			expect(outcome.handled).toBe(false);
		}
		expect(lines).toHaveLength(0);
	});

	test.each([
		[["--doctor-provider"]],
		[["--doctor-provider", "--doctor-level"]],
		[["--doctor-provider", "p", "--doctor-level", "2"]],
		[["--doctor-provider", "p", "--doctor-level", "abc"]],
		[["--doctor-provider", "p", "--doctor-timeout", "0"]],
		[["--doctor-provider", "p", "--doctor-timeout", "-5"]],
		[["--doctor-provider", "p", "--doctor-timeout", "abc"]],
		[["--doctor-provider", "p", "--doctor-model"]],
		[["--doctor-provider", "p", "--verbose"]],
		[["--doctor-provider", "p", "stray-message"]],
	])("reports usage errors as stable JSON with exit code 2 for %j", async (args) => {
		lines = [];
		const outcome = await runDoctorProviderCli(args, { agentDir, writeLine });
		expect(outcome).toMatchObject({ handled: true, exitCode: 2 });
		const parsed = JSON.parse(lines.join("\n")) as { status: string; error: { code: string; message: string } };
		expect(parsed.status).toBe("fail");
		expect(parsed.error.code).toBe("cli-usage");
		expect(parsed.error.message).toContain("--doctor-provider");
	});

	test("usage errors never echo unexpected argument values", async () => {
		const outcome = await runDoctorProviderCli(["--doctor-provider", "p", `sk-${SENTINEL}`], {
			agentDir,
			writeLine,
		});
		expect(outcome.exitCode).toBe(2);
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("handles the canonical provider doctor subcommand at level 0", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://custom.example.test/v1",
						api: "openai-completions",
						apiKey: SENTINEL,
						models: [{ id: "custom-model" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["provider", "doctor", "custom"], { agentDir, writeLine });

		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(parseOutput()).toMatchObject({ provider: "custom", status: "ok", level: 0 });
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("canonical subcommand accepts canonical flag spellings", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						apiKey: "configured",
						models: [{ id: "m1" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(
			["provider", "doctor", "pub", "--level", "1", "--model", "m1", "--timeout", "1234"],
			{ agentDir, writeLine, transport: sequenceTransport([404, 200]) },
		);

		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		expect(parseOutput()).toMatchObject({ status: "ok", level: 1, modelId: "m1" });
	});

	test("canonical --probe-model runs the level 2 probe with a cost warning", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						apiKey: "configured",
						models: [{ id: "m1" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["provider", "doctor", "pub", "--probe-model", "m1"], {
			agentDir,
			writeLine,
			transport: sequenceTransport([404, 200, 200]),
		});

		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		expect(parseOutput()).toMatchObject({ status: "ok", level: 2, costWarning: true, modelId: "m1" });
	});

	test("rejects conflicting --model and --probe-model bindings without dispatch", async () => {
		let calls = 0;
		const transport: ProviderDoctorTransport = {
			pinsResolvedAddress: true,
			async request() {
				calls++;
				return { status: 200 };
			},
		};

		const outcome = await runDoctorProviderCli(
			["provider", "doctor", "pub", "--model", "m1", "--probe-model", "m2"],
			{ agentDir, writeLine, transport },
		);

		expect(outcome).toMatchObject({ handled: true, exitCode: 2 });
		expect(calls).toBe(0);
		expect(lines.join("\n")).not.toContain("m1");
		expect(lines.join("\n")).not.toContain("m2");
	});

	test("Level 2 production auth uses AuthStorage and resolved provider/model headers", async () => {
		const storedKey = `${SENTINEL}-stored`;
		const providerHeader = `${SENTINEL}-provider-header`;
		const captured: Headers[] = [];
		vi.stubEnv("DOCTOR_PROVIDER_HEADER", providerHeader);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ pub: { type: "api_key", key: storedKey } }));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						apiKey: "$UNUSED_LOWER_PRECEDENCE_KEY",
						headers: { "x-provider-auth": "$DOCTOR_PROVIDER_HEADER", "x-precedence": "provider" },
						models: [{ id: "m1", headers: { "x-precedence": "model" } }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["provider", "doctor", "pub", "--probe-model", "m1"], {
			agentDir,
			writeLine,
			transport: materializingTransport([404, 200, 200], captured),
		});

		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		expect(captured).toHaveLength(3);
		for (const headers of captured) {
			expect(headers.get("Authorization")).toBe(`Bearer ${storedKey}`);
			expect(headers.get("x-provider-auth")).toBe(providerHeader);
			expect(headers.get("x-precedence")).toBe("model");
		}
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("Level 2 resolves models.json API-key refs and preserves explicit Authorization precedence", async () => {
		const modelKey = `${SENTINEL}-models-key`;
		const explicitAuthorization = `Custom ${SENTINEL}-authorization`;
		const captured: Headers[] = [];
		vi.stubEnv("DOCTOR_MODELS_KEY", modelKey);
		vi.stubEnv("DOCTOR_EXPLICIT_AUTH", explicitAuthorization);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-responses",
						apiKey: "$DOCTOR_MODELS_KEY",
						headers: { Authorization: "$DOCTOR_EXPLICIT_AUTH" },
						models: [{ id: "m1" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["provider", "doctor", "pub", "--probe-model", "m1"], {
			agentDir,
			writeLine,
			transport: materializingTransport([404, 200, 200], captured),
		});

		expect(outcome.exitCode).toBe(0);
		expect(captured.map((headers) => headers.get("Authorization"))).toEqual([
			explicitAuthorization,
			explicitAuthorization,
			explicitAuthorization,
		]);
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("rejects conflicting case-variant Authorization headers before dispatch", async () => {
		const captured: Headers[] = [];
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						apiKey: "configured",
						headers: {
							Authorization: `Bearer first-${SENTINEL}`,
							authorization: `Bearer second-${SENTINEL}`,
						},
						models: [{ id: "m1" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["provider", "doctor", "pub", "--probe-model", "m1"], {
			agentDir,
			writeLine,
			transport: materializingTransport([404, 200, 200], captured),
		});

		expect(outcome).toMatchObject({ handled: true, exitCode: 1 });
		expect(captured).toHaveLength(0);
		expect(parseOutput().error).toMatchObject({ category: "auth", code: "auth-materialization-failed" });
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("Level 2 materializes unexpired supported OAuth through AuthStorage", async () => {
		const oauthAccess = `${SENTINEL}-oauth-access`;
		const captured: Headers[] = [];
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				"qwen-oauth": {
					type: "oauth",
					refresh: `${SENTINEL}-oauth-refresh`,
					access: oauthAccess,
					expires: Date.now() + 60_000,
				},
			}),
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"qwen-oauth": {
						baseUrl: "https://qwen.example.test/v1",
						api: "openai-completions",
						apiKey: "$UNUSED_QWEN_FALLBACK",
						models: [{ id: "qwen3-coder-plus" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(
			["provider", "doctor", "qwen-oauth", "--probe-model", "qwen3-coder-plus"],
			{
				agentDir,
				writeLine,
				transport: materializingTransport([404, 200, 200], captured),
			},
		);

		expect(outcome.exitCode).toBe(0);
		expect(captured[0]?.get("Authorization")).toBe(`Bearer ${oauthAccess}`);
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("Level 2 fails as actionable auth before dispatch when a config ref is unresolved", async () => {
		const captured: Headers[] = [];
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						apiKey: "$DOCTOR_MISSING_SECRET_REF",
						models: [{ id: "m1" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["provider", "doctor", "pub", "--probe-model", "m1"], {
			agentDir,
			writeLine,
			transport: materializingTransport([404, 200, 200], captured),
		});

		expect(outcome).toMatchObject({ handled: true, exitCode: 1 });
		expect(captured).toHaveLength(0);
		expect(parseOutput()).toMatchObject({
			status: "fail",
			error: { category: "auth", code: "auth-materialization-failed" },
		});
		expect(lines.join("\n")).not.toContain("DOCTOR_MISSING_SECRET_REF");
	});

	test("Level 1 does not materialize command-backed auth even when transport asks for headers", async () => {
		const marker = join(agentDir, "level-1-auth-materialized");
		const captured: Headers[] = [];
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						apiKey: `!touch ${marker}`,
						models: [{ id: "m1" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["provider", "doctor", "pub", "--level", "1", "--model", "m1"], {
			agentDir,
			writeLine,
			transport: materializingTransport([404, 200], captured),
		});

		expect(outcome.exitCode).toBe(0);
		expect(captured.every((headers) => [...headers].length === 0)).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});

	test("legacy --doctor-provider alias supports --probe-model", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						apiKey: "configured",
						models: [{ id: "m1" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["--doctor-provider", "pub", "--probe-model", "m1"], {
			agentDir,
			writeLine,
			transport: sequenceTransport([404, 200, 200]),
		});

		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		expect(parseOutput()).toMatchObject({ status: "ok", level: 2, costWarning: true });
	});

	test("level 2 is unreachable through --level and --doctor-level", async () => {
		for (const flag of ["--level", "--doctor-level"]) {
			lines = [];
			const outcome = await runDoctorProviderCli(["provider", "doctor", "pub", flag, "2"], { agentDir, writeLine });
			expect(outcome).toMatchObject({ handled: true, exitCode: 2 });
			const parsed = JSON.parse(lines.join("\n")) as { error: { code: string; message: string } };
			expect(parsed.error.code).toBe("cli-usage");
			expect(parsed.error.message).toContain("--probe-model");
		}
	});

	test("canonical usage errors are stable and never echo values", async () => {
		for (const args of [
			["provider", "doctor"],
			["provider", "doctor", "p", "--probe-model"],
			["provider", "doctor", "p", `sk-${SENTINEL}`],
		]) {
			lines = [];
			const outcome = await runDoctorProviderCli(args, { agentDir, writeLine });
			expect(outcome).toMatchObject({ handled: true, exitCode: 2 });
			expect(JSON.parse(lines.join("\n"))).toMatchObject({ status: "fail", error: { code: "cli-usage" } });
		}
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("provider doctor --help prints usage without JSON failure and exits 0", async () => {
		const outcome = await runDoctorProviderCli(["provider", "doctor", "--help"], { agentDir, writeLine });
		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		const output = lines.join("\n");
		expect(output).toContain("provider doctor <provider-id>");
		expect(output).toContain("--probe-model");
		expect(output).toContain("cost");
	});

	test("runs Level 0 by default with zero network and sanitized JSON", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://custom.example.test/v1",
						api: "openai-completions",
						apiKey: SENTINEL,
						models: [{ id: "custom-model" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["--doctor-provider", "custom"], { agentDir, writeLine });

		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		expect(fetchSpy).not.toHaveBeenCalled();
		const result = parseOutput();
		expect(result).toMatchObject({
			provider: "custom",
			status: "ok",
			level: 0,
			origin: "custom-openai-compatible",
			targetUrl: "https://custom.example.test/v1",
			authPresent: true,
		});
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("exits 1 with a stable JSON error for unknown providers", async () => {
		const outcome = await runDoctorProviderCli(["--doctor-provider", "does-not-exist"], { agentDir, writeLine });
		expect(outcome).toMatchObject({ handled: true, exitCode: 1 });
		const result = parseOutput();
		expect(result.status).toBe("fail");
		expect(result.error).toMatchObject({ category: "config", code: "provider-not-found" });
	});

	test("runs Level 1 against a loopback provider with the production transport", async () => {
		const paths: string[] = [];
		const server: Server = createServer((request, response) => {
			paths.push(request.url ?? "");
			response.writeHead(200);
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"local-proxy-under-test": {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: SENTINEL,
						models: [{ id: "local-model" }],
					},
				},
			}),
		);

		try {
			const outcome = await runDoctorProviderCli(
				["--doctor-provider", "local-proxy-under-test", "--doctor-level", "1", "--doctor-timeout", "5000"],
				{ agentDir, writeLine },
			);

			expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
			const result = parseOutput();
			expect(result).toMatchObject({ status: "ok", level: 1, origin: "local-proxy" });
			expect(result.checks.find((check) => check.name === "root-endpoint")?.status).toBe("ok");
			expect(result.checks.find((check) => check.name === "models-endpoint")?.status).toBe("ok");
			expect(paths).toEqual(["/health", "/v1/models"]);
			expect(lines.join("\n")).not.toContain(SENTINEL);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
	});

	test("passes level, model, and timeout through to the doctor with an injected transport", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						apiKey: "configured",
						models: [{ id: "m1" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(
			["--doctor-provider", "pub", "--doctor-level", "1", "--doctor-model", "m1", "--doctor-timeout", "1234"],
			{ agentDir, writeLine, transport: sequenceTransport([404, 200]) },
		);

		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		const result = parseOutput();
		expect(result).toMatchObject({ status: "ok", level: 1, modelId: "m1" });
	});

	test("exits 1 when a Level 1 probe fails authentication", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					pub: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						apiKey: "configured",
						models: [{ id: "m1" }],
					},
				},
			}),
		);

		const outcome = await runDoctorProviderCli(["--doctor-provider", "pub", "--doctor-level", "1"], {
			agentDir,
			writeLine,
			transport: sequenceTransport([404, 401]),
		});

		expect(outcome).toMatchObject({ handled: true, exitCode: 1 });
		expect(parseOutput().error).toMatchObject({ category: "auth", code: "authentication-failed" });
	});

	test("binds custom Kimi Level 2 credentials to the openai_legacy endpoint", async () => {
		const nativeSecret = `${SENTINEL}-native-kimi`;
		const customSecret = `${SENTINEL}-custom-endpoint`;
		const captured: Headers[] = [];
		const kimiConfigPath = join(agentDir, "custom-kimi.toml");
		vi.stubEnv("KIMI_API_KEY", nativeSecret);
		vi.stubEnv("KIMI_BASE_URL", "");
		vi.stubEnv("KIMI_MODEL_NAME", "");
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: nativeSecret } }),
		);
		writeFileSync(
			kimiConfigPath,
			[
				"[providers.custom]",
				'type = "openai_legacy"',
				'base_url = "https://custom-kimi.example.test/v1"',
				'model_name = "custom-paid-model"',
				`api_key = "${customSecret}"`,
			].join("\n"),
		);

		const outcome = await runDoctorProviderCli(
			["provider", "doctor", "kimi-coding", "--probe-model", "custom-paid-model"],
			{
				agentDir,
				kimiConfigPath,
				writeLine,
				transport: materializingTransport([404, 200, 200], captured),
			},
		);

		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		expect(captured).toHaveLength(3);
		expect(captured.map((headers) => headers.get("authorization"))).toEqual([
			`Bearer ${customSecret}`,
			`Bearer ${customSecret}`,
			`Bearer ${customSecret}`,
		]);
		expect(captured.every((headers) => ![...headers.values()].some((value) => value.includes(nativeSecret)))).toBe(
			true,
		);
		expect(parseOutput()).toMatchObject({
			status: "ok",
			origin: "custom-openai-compatible",
			source: "kimi-config-toml:providers.custom",
			modelId: "custom-paid-model",
			authPresent: true,
		});
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("passes the Kimi config path override through to resolution", async () => {
		vi.stubEnv("KIMI_API_KEY", SENTINEL);
		vi.stubEnv("KIMI_BASE_URL", "");
		vi.stubEnv("KIMI_MODEL_NAME", "");
		const kimiConfigPath = join(agentDir, "config.toml");
		writeFileSync(kimiConfigPath, 'base_url = "https://kimi-cli.example.test/v1"\nmodel_name = "kimi-custom"\n');

		const outcome = await runDoctorProviderCli(["--doctor-provider", "kimi-coding"], {
			agentDir,
			kimiConfigPath,
			writeLine,
		});

		expect(outcome).toMatchObject({ handled: true, exitCode: 0 });
		const result = parseOutput();
		expect(result).toMatchObject({
			status: "ok",
			targetUrl: "https://kimi-cli.example.test/v1",
			modelId: "kimi-custom",
		});
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("main.ts wires the doctor CLI before regular argument parsing", () => {
		const mainSource = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf-8");
		expect(mainSource).toContain('from "./commands/doctor-provider-cli.ts"');
		const callIndex = mainSource.indexOf("runDoctorProviderCli(args)");
		const parseIndex = mainSource.indexOf("parseArgs(args)");
		expect(callIndex).toBeGreaterThan(-1);
		expect(parseIndex).toBeGreaterThan(-1);
		expect(callIndex).toBeLessThan(parseIndex);
	});
});
