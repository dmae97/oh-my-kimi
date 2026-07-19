import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	diagnoseProvider,
	diagnoseResolvedProvider,
	type ProviderDoctorLevel,
	type ProviderDoctorTransport,
	type ProviderDoctorTransportRequest,
	type ResolvedProviderTarget,
} from "../src/commands/doctor-provider.ts";

const SENTINEL = "doctor-sentinel-value";

function resolvedTarget(overrides: Partial<ResolvedProviderTarget> = {}): ResolvedProviderTarget {
	return {
		providerId: "test-provider",
		origin: "custom-openai-compatible",
		source: "injected-test",
		endpoint: {
			baseUrl: "https://provider.example.test/v1",
			api: "openai-completions",
			modelIds: ["test-model"],
		},
		auth: { present: true, source: "injected-test" },
		...overrides,
	};
}

function sequenceTransport(
	statuses: readonly number[],
	requests: ProviderDoctorTransportRequest[] = [],
	pinsResolvedAddress = true,
): ProviderDoctorTransport {
	let index = 0;
	return {
		pinsResolvedAddress,
		async request(request) {
			requests.push(request);
			return { status: statuses[index++] ?? 500 };
		},
	};
}

describe("provider doctor", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "omk-doctor-provider-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	test("Level 0 is the default and performs zero fetches", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const result = await diagnoseResolvedProvider(resolvedTarget());

		expect(result.status).toBe("ok");
		expect(result.level).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("Levels 0 and 1 do not invoke the injected auth resolver", async () => {
		const resolveAuthHeaders = vi.fn(async () => new Headers({ Authorization: `Bearer ${SENTINEL}` }));
		const requests: ProviderDoctorTransportRequest[] = [];
		const transport: ProviderDoctorTransport = {
			pinsResolvedAddress: true,
			async request(request) {
				requests.push(request);
				await request.createHeaders();
				return { status: requests.length === 1 ? 404 : 200 };
			},
		};

		const level0 = await diagnoseResolvedProvider(resolvedTarget(), {}, { resolveAuthHeaders });
		const level1 = await diagnoseResolvedProvider(resolvedTarget(), { level: 1 }, { transport, resolveAuthHeaders });

		expect(level0.status).toBe("ok");
		expect(level1.status).toBe("ok");
		expect(resolveAuthHeaders).not.toHaveBeenCalled();
		expect(requests).toHaveLength(2);
	});

	test.each([
		["native", "https://native.example.test/v1", "anthropic-messages"],
		["custom-openai-compatible", "https://custom.example.test/v1", "openai-completions"],
		["local-proxy", "http://localhost:9996/v1", "openai-completions"],
	] as const)("accepts valid %s Level 0 targets", async (origin, baseUrl, api) => {
		const result = await diagnoseResolvedProvider(
			resolvedTarget({ origin, endpoint: { baseUrl, api, modelIds: ["test-model"] } }),
		);
		expect(result.status).toBe("ok");
		expect(result.origin).toBe(origin);
	});

	test("uses injected transport, preserves /v1, and treats root 404 as neutral", async () => {
		const requests: ProviderDoctorTransportRequest[] = [];
		const result = await diagnoseResolvedProvider(resolvedTarget(), {
			level: 1,
			transport: sequenceTransport([404, 200], requests),
		});

		expect(result.status).toBe("ok");
		expect(requests.map((request) => request.url.href)).toEqual([
			"https://provider.example.test/v1",
			"https://provider.example.test/v1/models",
		]);
		for (const request of requests) {
			expect(request.method).toBe("GET");
			expect(request.redirect).toBe("manual");
			expect(request.signal).toBeInstanceOf(AbortSignal);
			expect(request.addressPolicy).toEqual({ kind: "public", requireAddressPinning: true });
		}
		expect(result.checks.find((check) => check.name === "root-endpoint")?.status).toBe("unsupported");
		expect(result.checks.find((check) => check.name === "models-endpoint")?.status).toBe("ok");
	});

	test("root 404 plus models 404 is overall ok with unsupported checks", async () => {
		const result = await diagnoseResolvedProvider(resolvedTarget(), {
			level: 1,
			transport: sequenceTransport([404, 404]),
		});

		expect(result.status).toBe("ok");
		expect(result.error).toBeUndefined();
		expect(result.checks.filter((check) => check.status === "unsupported")).toHaveLength(2);
	});

	test.each([401, 403])("classifies models HTTP %s as auth failure", async (status) => {
		const result = await diagnoseResolvedProvider(resolvedTarget(), {
			level: 1,
			transport: sequenceTransport([404, status]),
		});

		expect(result.status).toBe("fail");
		expect(result.error).toMatchObject({ category: "auth", code: "authentication-failed" });
	});

	test("does not serialize a key or raw thrown transport error", async () => {
		const target = resolvedTarget({
			auth: {
				present: true,
				source: "injected-test",
				createHeaders: () => new Headers({ Authorization: `Bearer ${SENTINEL}` }),
			},
		});
		const transport: ProviderDoctorTransport = {
			pinsResolvedAddress: true,
			async request(request) {
				expect((await request.createHeaders()).get("Authorization")).toContain(SENTINEL);
				throw new Error(`transport exposed ${SENTINEL}`);
			},
		};

		const result = await diagnoseResolvedProvider(target, { level: 1, transport });
		const serialized = JSON.stringify(result);
		expect(result.error).toMatchObject({ category: "network", code: "network-failure" });
		expect(serialized).not.toContain(SENTINEL);
		expect(serialized).not.toContain("transport exposed");
	});

	test("sanitizes URL userinfo, query, and fragment before probing or returning", async () => {
		const requests: ProviderDoctorTransportRequest[] = [];
		const target = resolvedTarget({
			endpoint: {
				baseUrl: `https://user:${SENTINEL}@provider.example.test/v1?api_key=${SENTINEL}#${SENTINEL}`,
				api: "openai-completions",
				modelIds: ["test-model"],
			},
		});
		const result = await diagnoseResolvedProvider(target, {
			level: 1,
			transport: sequenceTransport([404, 200], requests),
		});

		expect(result.targetUrl).toBe("https://provider.example.test/v1");
		expect(requests.every((request) => !request.url.href.includes(SENTINEL))).toBe(true);
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
	});

	test("rejects malformed URLs without echoing them", async () => {
		const result = await diagnoseResolvedProvider(
			resolvedTarget({
				endpoint: { baseUrl: `not-a-url-${SENTINEL}`, api: "openai-completions", modelIds: ["test-model"] },
			}),
		);
		expect(result.error).toMatchObject({ category: "config", code: "base-url-invalid" });
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
	});

	test("times out an injected transport even when it never settles", async () => {
		const transport: ProviderDoctorTransport = {
			pinsResolvedAddress: true,
			request: () => new Promise(() => undefined),
		};
		const result = await diagnoseResolvedProvider(resolvedTarget(), { level: 1, timeoutMs: 5, transport });

		expect(result.error).toMatchObject({ category: "network", code: "request-timeout" });
	});

	test("honors a pre-aborted signal without calling transport", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const transport: ProviderDoctorTransport = {
			pinsResolvedAddress: true,
			async request() {
				calls++;
				return { status: 200 };
			},
		};
		const result = await diagnoseResolvedProvider(resolvedTarget(), {
			level: 1,
			signal: controller.signal,
			transport,
		});

		expect(calls).toBe(0);
		expect(result.error).toMatchObject({ category: "network", code: "request-aborted" });
	});

	test("honors a caller abort while transport is in flight", async () => {
		const controller = new AbortController();
		let resolveStarted = (): void => {};
		const started = new Promise<void>((resolve) => {
			resolveStarted = () => resolve();
		});
		let calls = 0;
		const transport: ProviderDoctorTransport = {
			pinsResolvedAddress: true,
			request() {
				calls++;
				resolveStarted();
				return new Promise(() => undefined);
			},
		};
		const pendingResult = diagnoseResolvedProvider(resolvedTarget(), {
			level: 1,
			signal: controller.signal,
			transport,
		});

		await started;
		controller.abort();
		const result = await pendingResult;

		expect(calls).toBe(1);
		expect(result.error).toMatchObject({ category: "network", code: "request-aborted" });
	});

	test("blocks redirects without exposing response headers", async () => {
		const result = await diagnoseResolvedProvider(resolvedTarget(), {
			level: 1,
			transport: sequenceTransport([404, 302]),
		});
		expect(result.error).toMatchObject({ category: "config", code: "redirect-blocked" });
		expect(JSON.stringify(result)).not.toContain("location");
	});

	test.each([
		["https://10.0.0.1/v1", "native"],
		["https://169.254.169.254/v1", "custom-openai-compatible"],
		["https://[::1]/v1", "native"],
		["http://proxy.example.test/v1", "local-proxy"],
	] as const)("blocks address-policy violation %s", async (baseUrl, origin) => {
		const result = await diagnoseResolvedProvider(
			resolvedTarget({ origin, endpoint: { baseUrl, api: "openai-completions", modelIds: ["test-model"] } }),
		);
		expect(result.error).toMatchObject({ category: "config", code: "address-policy-blocked" });
	});

	test("normalizes terminal DNS root dots before loopback and public-host classification", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"dotted-localhost": {
						baseUrl: "https://localhost./v1",
						api: "openai-completions",
						apiKey: "configured",
						models: [{ id: "local-model" }],
					},
					"dotted-localhost-subdomain": {
						baseUrl: "https://x.localhost./v1",
						api: "openai-completions",
						apiKey: "configured",
						models: [{ id: "subdomain-model" }],
					},
					"dotted-public": {
						baseUrl: "https://provider.example.test./v1",
						api: "openai-completions",
						apiKey: "configured",
						models: [{ id: "public-model" }],
					},
				},
			}),
		);

		const local = await diagnoseProvider("dotted-localhost", { agentDir, modelId: "local-model" });
		const subdomain = await diagnoseProvider("dotted-localhost-subdomain", {
			agentDir,
			modelId: "subdomain-model",
		});
		let publicTransportCalls = 0;
		const publicResult = await diagnoseProvider("dotted-public", {
			agentDir,
			level: 1,
			modelId: "public-model",
			transport: {
				async request() {
					publicTransportCalls++;
					return { status: 200 };
				},
			},
		});

		expect(local).toMatchObject({ status: "ok", origin: "local-proxy" });
		expect(subdomain).toMatchObject({
			status: "fail",
			origin: "custom-openai-compatible",
			error: { category: "config", code: "address-policy-blocked" },
		});
		expect(publicTransportCalls).toBe(0);
		expect(publicResult).toMatchObject({
			status: "fail",
			origin: "custom-openai-compatible",
			error: { category: "config", code: "address-pinning-required" },
		});
	});

	test("requires public transports to declare address pinning", async () => {
		let calls = 0;
		const transport: ProviderDoctorTransport = {
			async request() {
				calls++;
				return { status: 200 };
			},
		};
		const result = await diagnoseResolvedProvider(resolvedTarget(), { level: 1, transport });
		expect(calls).toBe(0);
		expect(result.error).toMatchObject({ category: "config", code: "address-pinning-required" });
	});

	test("allows an unpinned local transport and probes /health", async () => {
		const requests: ProviderDoctorTransportRequest[] = [];
		const target = resolvedTarget({
			origin: "local-proxy",
			endpoint: { baseUrl: "http://127.9.8.7:9996/v1", api: "openai-completions", modelIds: ["test-model"] },
		});
		const result = await diagnoseResolvedProvider(target, {
			level: 1,
			transport: sequenceTransport([200, 404], requests, false),
		});

		expect(result.status).toBe("ok");
		expect(requests[0].url.href).toBe("http://127.9.8.7:9996/health");
		expect(requests[0].addressPolicy).toEqual({ kind: "loopback-only", requireAddressPinning: false });
	});

	test("rejects a model/provider mismatch at Level 0", async () => {
		const result = await diagnoseResolvedProvider(resolvedTarget(), { modelId: "other-model" });
		expect(result.error).toMatchObject({ category: "model", code: "model-provider-mismatch" });
	});

	test("rejects unsupported doctor levels without probing", async () => {
		const invalidLevel = 3 as ProviderDoctorLevel;
		let calls = 0;
		const transport: ProviderDoctorTransport = {
			pinsResolvedAddress: true,
			async request() {
				calls++;
				return { status: 200 };
			},
		};
		const result = await diagnoseResolvedProvider(resolvedTarget(), { level: invalidLevel, transport });
		expect(calls).toBe(0);
		expect(result.error).toMatchObject({ category: "config", code: "unsupported-level" });
	});

	test("maps retryable HTTP and thrown failures to stable network errors", async () => {
		for (const status of [408, 429]) {
			const result = await diagnoseResolvedProvider(resolvedTarget(), {
				level: 1,
				transport: sequenceTransport([status]),
			});
			expect(result.error).toMatchObject({ category: "network", code: "network-failure" });
		}
	});

	test("separates 5xx responses into the server category", async () => {
		for (const status of [500, 502, 503]) {
			const result = await diagnoseResolvedProvider(resolvedTarget(), {
				level: 1,
				transport: sequenceTransport([404, status]),
			});
			expect(result.status).toBe("fail");
			expect(result.error).toMatchObject({ category: "server", code: "server-error" });
			expect(result.checks.find((check) => check.name === "models-endpoint")?.probe).toEqual({
				reachable: true,
				status,
				category: "server",
			});
		}
	});

	test("attaches exact-category endpoint probe results to Level 1 checks", async () => {
		const ok = await diagnoseResolvedProvider(resolvedTarget(), {
			level: 1,
			transport: sequenceTransport([404, 200]),
		});
		expect(ok.checks.find((check) => check.name === "root-endpoint")?.probe).toEqual({
			reachable: true,
			status: 404,
			category: "unsupported-endpoint",
		});
		expect(ok.checks.find((check) => check.name === "models-endpoint")?.probe).toEqual({
			reachable: true,
			authenticated: true,
			modelsSupported: true,
			status: 200,
			category: "ok",
		});

		const auth = await diagnoseResolvedProvider(resolvedTarget(), {
			level: 1,
			transport: sequenceTransport([404, 401]),
		});
		expect(auth.checks.find((check) => check.name === "models-endpoint")?.probe).toEqual({
			reachable: true,
			authenticated: false,
			status: 401,
			category: "auth",
		});

		const down: ProviderDoctorTransport = {
			pinsResolvedAddress: true,
			async request() {
				throw new Error("boom");
			},
		};
		const network = await diagnoseResolvedProvider(resolvedTarget(), { level: 1, transport: down });
		expect(network.checks.find((check) => check.name === "root-endpoint")?.probe).toEqual({
			reachable: false,
			category: "network",
		});
	});

	test("keyless custom OpenAI-compatible targets skip the credential-presence requirement", async () => {
		const result = await diagnoseResolvedProvider(resolvedTarget({ auth: { present: false } }));
		expect(result.status).toBe("ok");
		expect(result.authPresent).toBe(false);
		expect(result.checks.find((check) => check.name === "auth-present")?.status).toBe("skipped");
		expect(result.checks.find((check) => check.name === "native-provider-checks")?.status).toBe("skipped");
	});

	test("native targets still require credential presence", async () => {
		const result = await diagnoseResolvedProvider(
			resolvedTarget({
				origin: "native",
				endpoint: {
					baseUrl: "https://native.example.test/v1",
					api: "anthropic-messages",
					modelIds: ["test-model"],
				},
				auth: { present: false },
			}),
		);
		expect(result.status).toBe("fail");
		expect(result.error).toMatchObject({ category: "auth", code: "auth-missing" });
	});

	describe("level 2 opt-in model probe", () => {
		test("level 2 without a probe model fails closed without any request", async () => {
			let calls = 0;
			const transport: ProviderDoctorTransport = {
				pinsResolvedAddress: true,
				async request() {
					calls++;
					return { status: 200 };
				},
			};
			const result = await diagnoseResolvedProvider(resolvedTarget(), { level: 2, transport });
			expect(calls).toBe(0);
			expect(result.status).toBe("fail");
			expect(result.error).toMatchObject({ category: "config", code: "probe-model-required" });
			expect(result.costWarning).toBeUndefined();
		});

		test("rejects conflicting validation and paid probe model bindings before any request", async () => {
			let calls = 0;
			const transport: ProviderDoctorTransport = {
				pinsResolvedAddress: true,
				async request() {
					calls++;
					return { status: 200 };
				},
			};

			const result = await diagnoseResolvedProvider(
				resolvedTarget({
					endpoint: {
						baseUrl: "https://provider.example.test/v1",
						api: "openai-completions",
						modelIds: ["test-model", "other-model"],
					},
				}),
				{ level: 2, modelId: "test-model", probeModelId: "other-model", transport },
			);

			expect(calls).toBe(0);
			expect(result.error).toMatchObject({ category: "model", code: "probe-model-conflict" });
			expect(result.costWarning).toBeUndefined();
		});

		test("issues one bounded minimal-token POST after the GET probes", async () => {
			const requests: ProviderDoctorTransportRequest[] = [];
			const result = await diagnoseResolvedProvider(resolvedTarget(), {
				level: 2,
				probeModelId: "test-model",
				transport: sequenceTransport([404, 200, 200], requests),
			});

			expect(result.status).toBe("ok");
			expect(result.level).toBe(2);
			expect(result.costWarning).toBe(true);
			expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "POST"]);
			const post = requests[2];
			expect(post.url.href).toBe("https://provider.example.test/v1/chat/completions");
			expect(post.contentType).toBe("application/json");
			expect(post.redirect).toBe("manual");
			const body = JSON.parse(post.body ?? "{}") as Record<string, unknown>;
			expect(body).toEqual({
				model: "test-model",
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				stream: false,
			});
			expect(body.tools).toBeUndefined();
			const check = result.checks.find((entry) => entry.name === "model-probe");
			expect(check?.status).toBe("ok");
			expect(check?.probe).toEqual({ reachable: true, authenticated: true, status: 200, category: "ok" });
			expect(check?.message).toContain("cost");
		});

		test("classifies a rejected model probe as an auth failure", async () => {
			const result = await diagnoseResolvedProvider(resolvedTarget(), {
				level: 2,
				probeModelId: "test-model",
				transport: sequenceTransport([404, 200, 401]),
			});
			expect(result.status).toBe("fail");
			expect(result.costWarning).toBe(true);
			expect(result.error).toMatchObject({ category: "auth", code: "authentication-failed" });
		});

		test("levels 0 and 1 stay GET-only even when a probe model is supplied", async () => {
			const requests: ProviderDoctorTransportRequest[] = [];
			const level1 = await diagnoseResolvedProvider(resolvedTarget(), {
				level: 1,
				probeModelId: "test-model",
				transport: sequenceTransport([404, 200], requests),
			});
			expect(level1.status).toBe("ok");
			expect(level1.costWarning).toBeUndefined();
			expect(requests).toHaveLength(2);
			expect(requests.every((request) => request.method === "GET" && request.body === undefined)).toBe(true);

			const fetchSpy = vi.spyOn(globalThis, "fetch");
			const level0 = await diagnoseResolvedProvider(resolvedTarget(), { probeModelId: "test-model" });
			expect(level0.level).toBe(0);
			expect(level0.costWarning).toBeUndefined();
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		test("requires an OpenAI-compatible API for the model probe", async () => {
			const requests: ProviderDoctorTransportRequest[] = [];
			const result = await diagnoseResolvedProvider(
				resolvedTarget({
					origin: "native",
					endpoint: {
						baseUrl: "https://native.example.test/v1",
						api: "anthropic-messages",
						modelIds: ["test-model"],
					},
				}),
				{ level: 2, probeModelId: "test-model", transport: sequenceTransport([404, 200], requests) },
			);
			expect(result.status).toBe("fail");
			expect(result.error).toMatchObject({ category: "config", code: "api-unsupported" });
			expect(requests.every((request) => request.method === "GET")).toBe(true);
		});

		test("fails the relation check before probing when the probe model is foreign", async () => {
			let calls = 0;
			const transport: ProviderDoctorTransport = {
				pinsResolvedAddress: true,
				async request() {
					calls++;
					return { status: 200 };
				},
			};
			const result = await diagnoseResolvedProvider(resolvedTarget(), {
				level: 2,
				probeModelId: "foreign-model",
				transport,
			});
			expect(calls).toBe(0);
			expect(result.error).toMatchObject({ category: "model", code: "model-provider-mismatch" });
		});

		test("level 2 output never echoes credentials or the probe body", async () => {
			const target = resolvedTarget({
				auth: {
					present: true,
					source: "injected-test",
					createHeaders: () => new Headers({ Authorization: `Bearer ${SENTINEL}` }),
				},
			});
			const result = await diagnoseResolvedProvider(target, {
				level: 2,
				probeModelId: "test-model",
				transport: sequenceTransport([404, 200, 200]),
			});
			const serialized = JSON.stringify(result);
			expect(result.status).toBe("ok");
			expect(serialized).not.toContain(SENTINEL);
			expect(serialized).not.toContain('"messages"');
		});

		test("fails closed as auth before dispatch when Level 2 auth cannot materialize", async () => {
			let dispatched = 0;
			const transport: ProviderDoctorTransport = {
				pinsResolvedAddress: true,
				async request(request) {
					await request.createHeaders();
					dispatched++;
					return { status: 200 };
				},
			};

			const result = await diagnoseResolvedProvider(
				resolvedTarget(),
				{ level: 2, probeModelId: "test-model" },
				{
					transport,
					resolveAuthHeaders: async () => {
						throw new Error(`resolver leaked ${SENTINEL}`);
					},
				},
			);

			expect(dispatched).toBe(0);
			expect(result).toMatchObject({
				status: "fail",
				error: { category: "auth", code: "auth-materialization-failed" },
			});
			expect(result.costWarning).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain(SENTINEL);
		});

		test("does not mark cost or dispatch POST when auth fails at the paid request boundary", async () => {
			let authCalls = 0;
			let postDispatches = 0;
			let requests = 0;
			const transport: ProviderDoctorTransport = {
				pinsResolvedAddress: true,
				async request(request) {
					await request.createHeaders();
					requests++;
					if (request.method === "POST") postDispatches++;
					return { status: requests === 1 ? 404 : 200 };
				},
			};

			const result = await diagnoseResolvedProvider(
				resolvedTarget(),
				{ level: 2, probeModelId: "test-model" },
				{
					transport,
					resolveAuthHeaders: async () => {
						authCalls++;
						if (authCalls === 3) throw new Error(`late resolver leak ${SENTINEL}`);
						return new Headers({ Authorization: "Bearer safe-test-value" });
					},
				},
			);

			expect(requests).toBe(2);
			expect(postDispatches).toBe(0);
			expect(result.error).toMatchObject({ category: "auth", code: "auth-materialization-failed" });
			expect(result.costWarning).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain(SENTINEL);
		});
	});

	test("resolves custom model endpoint metadata and auth presence from explicit agentDir", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://custom.example.test/v1",
						api: "openai-completions",
						models: [{ id: "custom-model" }],
					},
				},
			}),
		);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ custom: { type: "api_key", key: SENTINEL } }));

		const result = await diagnoseProvider("custom", { agentDir, modelId: "custom-model" });
		expect(result).toMatchObject({
			status: "ok",
			origin: "custom-openai-compatible",
			source: "models.json",
			targetUrl: "https://custom.example.test/v1",
			api: "openai-completions",
			modelId: "custom-model",
			authPresent: true,
		});
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
	});

	test("respects OMK_CODING_AGENT_DIR", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					envdir: {
						baseUrl: "https://envdir.example.test/v1",
						api: "openai-completions",
						apiKey: "configured",
						models: [{ id: "env-model" }],
					},
				},
			}),
		);
		vi.stubEnv("OMK_CODING_AGENT_DIR", agentDir);

		const result = await diagnoseProvider("envdir", { modelId: "env-model" });
		expect(result.status).toBe("ok");
		expect(result.targetUrl).toBe("https://envdir.example.test/v1");
	});

	test("reports malformed models JSON as config instead of provider-not-found", async () => {
		writeFileSync(join(agentDir, "models.json"), "{ malformed");
		const result = await diagnoseProvider("missing", { agentDir });
		expect(result.error).toMatchObject({ category: "config", code: "models-config-invalid" });
	});

	test("reports malformed auth JSON as config instead of provider-not-found", async () => {
		writeFileSync(join(agentDir, "auth.json"), "{ malformed");
		const result = await diagnoseProvider("missing", { agentDir });
		expect(result.error).toMatchObject({ category: "config", code: "auth-config-invalid" });
	});

	test("does not execute command-backed credentials at Level 0", async () => {
		const marker = join(agentDir, "credential-command-ran");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					commanded: {
						baseUrl: "https://commanded.example.test/v1",
						api: "openai-completions",
						apiKey: `!touch ${marker}`,
						models: [{ id: "command-model" }],
					},
				},
			}),
		);

		const result = await diagnoseProvider("commanded", { agentDir, modelId: "command-model" });
		expect(result.status).toBe("ok");
		expect(existsSync(marker)).toBe(false);
	});

	test("resolves native providers and local Grok defaults without network", async () => {
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: SENTINEL } }));
		const native = await diagnoseProvider("openai", { agentDir });
		const grok = await diagnoseProvider("grok-oauth-proxy", { agentDir });

		expect(native.status).toBe("ok");
		expect(native.origin).toBe("native");
		expect(native.targetUrl?.startsWith("https://")).toBe(true);
		expect(grok).toMatchObject({
			status: "ok",
			origin: "local-proxy",
			targetUrl: "http://127.0.0.1:9996/v1",
			authPresent: true,
		});
		expect(JSON.stringify(native)).not.toContain(SENTINEL);
	});

	test("Level 1 requires an explicitly injected transport", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const result = await diagnoseResolvedProvider(resolvedTarget(), { level: 1 });
		expect(result.error).toMatchObject({ category: "config", code: "transport-required" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	describe("kimi config TOML resolution", () => {
		let kimiConfigPath: string;

		beforeEach(() => {
			kimiConfigPath = join(agentDir, "kimi-config.toml");
			vi.stubEnv("KIMI_API_KEY", SENTINEL);
			vi.stubEnv("KIMI_BASE_URL", "");
			vi.stubEnv("KIMI_MODEL_NAME", "");
		});

		test("resolves base_url and model_name from the Kimi config TOML without network", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch");
			writeFileSync(
				kimiConfigPath,
				[
					"# Kimi CLI configuration",
					'base_url = "https://kimi-custom.example.test/v1" # trailing comment',
					'model_name = "kimi-custom-model"',
					`api_key = "${SENTINEL}"`,
				].join("\n"),
			);

			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });

			expect(result).toMatchObject({
				status: "ok",
				origin: "native",
				source: "kimi-config-toml",
				targetUrl: "https://kimi-custom.example.test/v1",
				modelId: "kimi-custom-model",
				authPresent: true,
			});
			expect(result.checks.find((check) => check.name === "model-provider-relation")?.status).toBe("ok");
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(JSON.stringify(result)).not.toContain(SENTINEL);
		});

		test("decodes escaped basic strings", async () => {
			writeFileSync(
				kimiConfigPath,
				'base_url = "https://kimi.example.test/\\u0076\\u0031"\nmodel_name = "kimi \\"quoted\\" model"\n',
			);

			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });

			expect(result.targetUrl).toBe("https://kimi.example.test/v1");
			expect(result.modelId).toBe('kimi "quoted" model');
		});

		test("accepts literal single-quoted strings", async () => {
			writeFileSync(kimiConfigPath, "base_url = 'https://literal.example.test/v1'\n");
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result.targetUrl).toBe("https://literal.example.test/v1");
		});

		test("finds keys inside provider tables", async () => {
			writeFileSync(
				kimiConfigPath,
				["[providers.ollama]", 'type = "openai_legacy"', 'base_url = "https://table.example.test/v1"'].join("\n"),
			);
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result.targetUrl).toBe("https://table.example.test/v1");
		});

		test("issue #9: an openai_legacy [providers.*] entry is diagnosed as custom-openai-compatible, not native", async () => {
			vi.stubEnv("KIMI_API_KEY", "");
			writeFileSync(
				kimiConfigPath,
				[
					"# issue #9 fixture: Kimi CLI pointed at a custom OpenAI-compatible provider",
					'default_model = "ollama-model"',
					"",
					"[providers.ollama]",
					'type = "openai_legacy"',
					'base_url = "https://ollama.example.test/v1"',
					'model_name = "ollama-model"',
				].join("\n"),
			);

			const requests: ProviderDoctorTransportRequest[] = [];
			const result = await diagnoseProvider("kimi-coding", {
				agentDir,
				kimiConfigPath,
				level: 1,
				transport: sequenceTransport([404, 200], requests),
			});

			expect(result).toMatchObject({
				status: "ok",
				origin: "custom-openai-compatible",
				source: "kimi-config-toml:providers.ollama",
				targetUrl: "https://ollama.example.test/v1",
				api: "openai-completions",
				modelId: "ollama-model",
				authPresent: false,
			});
			expect(result.checks.find((check) => check.name === "native-provider-checks")?.status).toBe("skipped");
			expect(result.checks.find((check) => check.name === "auth-present")?.status).toBe("skipped");
			expect(result.checks.find((check) => check.name === "root-endpoint")?.status).toBe("unsupported");
			expect(result.checks.find((check) => check.name === "models-endpoint")?.status).toBe("ok");
			expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
		});

		test("root Kimi config keys keep native classification and beat provider tables", async () => {
			writeFileSync(
				kimiConfigPath,
				[
					'base_url = "https://root.example.test/v1"',
					"[providers.ollama]",
					'type = "openai_legacy"',
					'base_url = "https://table.example.test/v1"',
				].join("\n"),
			);
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result).toMatchObject({
				origin: "native",
				source: "kimi-config-toml",
				targetUrl: "https://root.example.test/v1",
			});
		});

		test("KIMI_BASE_URL beats an openai_legacy provider table", async () => {
			vi.stubEnv("KIMI_BASE_URL", "https://from-env.example.test/v1");
			writeFileSync(
				kimiConfigPath,
				["[providers.ollama]", 'type = "openai_legacy"', 'base_url = "https://table.example.test/v1"'].join("\n"),
			);
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result).toMatchObject({
				origin: "native",
				source: "kimi-environment",
				targetUrl: "https://from-env.example.test/v1",
			});
		});

		test("non-openai_legacy provider tables are not selected as endpoints", async () => {
			writeFileSync(
				kimiConfigPath,
				["[providers.moonshot]", 'type = "kimi"', 'base_url = "https://moonshot-table.example.test/v1"'].join("\n"),
			);
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result).toMatchObject({
				status: "ok",
				origin: "native",
				source: "built-in-model-registry",
				targetUrl: "https://api.kimi.com/coding",
			});
		});

		test("malformed values inside provider tables are rejected with a sanitized line reference", async () => {
			writeFileSync(
				kimiConfigPath,
				["[providers.bad]", "type = 42", `base_url = "https://${SENTINEL}.example.test/v1"`].join("\n"),
			);
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result.error).toMatchObject({ category: "config", code: "kimi-config-invalid" });
			expect(result.error?.message).toContain("line 2");
			expect(JSON.stringify(result)).not.toContain(SENTINEL);
		});

		test("reports malformed TOML with an actionable sanitized parse error", async () => {
			writeFileSync(
				kimiConfigPath,
				[`api_key = "${SENTINEL}"`, `base_url = "https://${SENTINEL}-unterminated`].join("\n"),
			);

			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });

			expect(result.status).toBe("fail");
			expect(result.error).toMatchObject({ category: "config", code: "kimi-config-invalid" });
			expect(result.error?.message).toContain("line 2");
			expect(JSON.stringify(result)).not.toContain(SENTINEL);
		});

		test.each([
			["malformed root line", `api_key = "${SENTINEL}"\nnot an assignment`, 2],
			["malformed provider assignment", `[providers.bad]\ntype "openai_legacy"\nsecret = "${SENTINEL}"`, 2],
			["unterminated provider table", `[providers.${SENTINEL}\ntype = "openai_legacy"`, 1],
			["trailing table garbage", `[providers.bad] ${SENTINEL}\ntype = "openai_legacy"`, 1],
			["unterminated multiline string", `notes = """${SENTINEL}\nstill open`, 1],
			["unterminated multiline array", `features = ["safe", "${SENTINEL}"`, 1],
		] as const)("rejects %s without echoing TOML content", async (_name, content, line) => {
			writeFileSync(kimiConfigPath, content);
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result.error).toMatchObject({ category: "config", code: "kimi-config-invalid" });
			expect(result.error?.message).toContain(`line ${line}`);
			expect(JSON.stringify(result)).not.toContain(SENTINEL);
		});

		test("allows valid unrelated TOML keys and multiline values in root and unrelated tables", async () => {
			writeFileSync(
				kimiConfigPath,
				[
					"telemetry = true",
					"retries = 3",
					'features = ["safe", { enabled = true }]',
					'notes = """',
					"multiline notes",
					'"""',
					'base_url = "https://valid-unrelated.example.test/v1"',
					"[ui.preferences]",
					'theme = "dark"',
					"[providers.good]",
					'type = "kimi"',
					"timeout = 30",
				].join("\n"),
			);

			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result).toMatchObject({ status: "ok", targetUrl: "https://valid-unrelated.example.test/v1" });
		});

		test("accepts a valid multiline string for a relevant value", async () => {
			writeFileSync(kimiConfigPath, 'model_name = """\nmultiline-model"""\n');
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result).toMatchObject({ status: "ok", modelId: "multiline-model" });
		});

		test("rejects non-string values for the parsed keys", async () => {
			writeFileSync(kimiConfigPath, "model_name = 42\n");
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result.error).toMatchObject({ category: "config", code: "kimi-config-invalid" });
			expect(result.error?.message).toContain("line 1");
		});

		test("KIMI_BASE_URL and KIMI_MODEL_NAME env overrides win over the TOML file", async () => {
			writeFileSync(kimiConfigPath, 'base_url = "https://from-file.example.test/v1"\nmodel_name = "file-model"\n');
			vi.stubEnv("KIMI_BASE_URL", "https://from-env.example.test/v1");
			vi.stubEnv("KIMI_MODEL_NAME", "env-model");

			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });

			expect(result).toMatchObject({
				status: "ok",
				source: "kimi-environment",
				targetUrl: "https://from-env.example.test/v1",
				modelId: "env-model",
			});
		});

		test("models.json stays the highest-precedence source", async () => {
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						"kimi-coding": { baseUrl: "https://models-json.example.test/v1", api: "anthropic-messages" },
					},
				}),
			);
			writeFileSync(kimiConfigPath, 'base_url = "https://from-file.example.test/v1"\n');
			vi.stubEnv("KIMI_BASE_URL", "https://from-env.example.test/v1");

			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });

			expect(result).toMatchObject({ source: "models.json", targetUrl: "https://models-json.example.test/v1" });
		});

		test("falls back to the built-in registry when the Kimi config file is missing", async () => {
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result).toMatchObject({
				status: "ok",
				source: "built-in-model-registry",
				targetUrl: "https://api.kimi.com/coding",
			});
		});

		test("keeps the native default base URL when the TOML only names a model", async () => {
			writeFileSync(kimiConfigPath, 'model_name = "toml-only-model"\n');
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath });
			expect(result).toMatchObject({
				status: "ok",
				targetUrl: "https://api.kimi.com/coding",
				modelId: "toml-only-model",
			});
		});

		test("an explicitly requested model still fails the provider relation when unknown", async () => {
			writeFileSync(kimiConfigPath, 'model_name = "toml-model"\n');
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath, modelId: "unrelated" });
			expect(result.error).toMatchObject({ category: "model", code: "model-provider-mismatch" });
		});

		test("an explicitly requested TOML model passes the provider relation", async () => {
			writeFileSync(kimiConfigPath, 'model_name = "toml-model"\n');
			const result = await diagnoseProvider("kimi-coding", { agentDir, kimiConfigPath, modelId: "toml-model" });
			expect(result.status).toBe("ok");
			expect(result.modelId).toBe("toml-model");
		});

		test("non-Kimi providers never read the Kimi config file", async () => {
			writeFileSync(kimiConfigPath, 'base_url = "unterminated\n');
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						custom: {
							baseUrl: "https://custom.example.test/v1",
							api: "openai-completions",
							apiKey: "configured",
						},
					},
				}),
			);

			const result = await diagnoseProvider("custom", { agentDir, kimiConfigPath });
			expect(result.status).toBe("ok");
		});
	});
});
