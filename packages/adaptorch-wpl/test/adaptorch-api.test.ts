import { describe, expect, it } from "vitest";
import type { AdaptOrchFetch } from "../src/adaptorch-api.ts";
import {
	ADAPTORCH_DEFAULT_API_URL,
	AdaptOrchApiClient,
	AdaptOrchApiError,
	assertSafeApiUrl,
	createAdaptOrchApiClientFromEnv,
	resolveAuthHeaders,
} from "../src/adaptorch-api.ts";

/**
 * User API v1 client. The contract is
 * `contracts/openapi/adaptorch-user-api.v1.yaml` in the Adaptorch-MCP
 * repository; this suite pins the parts that are easy to get quietly wrong:
 * which credential header is sent, which URLs are allowed, and that a
 * credential never reaches an error message.
 */

const OK = (body: unknown, status = 200) => ({ status, json: async () => body, text: async () => "" });

function recordingFetch(response: unknown = {}, status = 200) {
	const calls: Array<{ url: string; init: Parameters<AdaptOrchFetch>[1] }> = [];
	const fetch: AdaptOrchFetch = async (url, init) => {
		calls.push({ url, init });
		return OK(response, status);
	};
	return { calls, fetch };
}

const client = (fetch: AdaptOrchFetch, apiKey = "ado_tenant_key") =>
	new AdaptOrchApiClient({ baseUrl: "https://api.adaptorch.com", apiKey, fetch });

describe("resolveAuthHeaders", () => {
	it("sends a tenant ado_ key only as X-API-Key", () => {
		const headers = resolveAuthHeaders("ado_live_abc");
		expect(headers).toEqual({ "X-API-Key": "ado_live_abc" });
		expect(headers).not.toHaveProperty("Authorization");
	});

	it("sends a non-tenant service credential as a bearer token", () => {
		expect(resolveAuthHeaders("svc-123")).toEqual({ Authorization: "Bearer svc-123" });
	});

	it("refuses an empty credential rather than sending an unauthenticated request", () => {
		expect(() => resolveAuthHeaders("")).toThrow(/api key/i);
		expect(() => resolveAuthHeaders("   ")).toThrow(/api key/i);
	});
});

describe("assertSafeApiUrl", () => {
	it("accepts https", () => {
		expect(() => assertSafeApiUrl("https://api.adaptorch.com")).not.toThrow();
	});

	it("accepts plaintext http only for exact loopback hosts", () => {
		for (const url of ["http://localhost:8080", "http://127.0.0.1:9000", "http://[::1]:9000"]) {
			expect(() => assertSafeApiUrl(url), url).not.toThrow();
		}
	});

	it("rejects plaintext http to any non-loopback host", () => {
		for (const url of ["http://api.adaptorch.com", "http://localhost.evil.test", "http://127.0.0.1.evil.test"]) {
			expect(() => assertSafeApiUrl(url), url).toThrow(/https/i);
		}
	});

	it("rejects a non-http scheme", () => {
		expect(() => assertSafeApiUrl("file:///etc/passwd")).toThrow();
		expect(() => assertSafeApiUrl("not a url")).toThrow();
	});
});

describe("AdaptOrchApiClient endpoint mapping", () => {
	it("submits a run to POST /v1/runs", async () => {
		const { calls, fetch } = recordingFetch({ run_id: "r1", status: "QUEUED" }, 201);
		const run = await client(fetch).submitRun({ subtasks: [{ prompt: "x" }] });

		expect(calls[0]?.url).toBe("https://api.adaptorch.com/v1/runs");
		expect(calls[0]?.init.method).toBe("POST");
		expect(run.status).toBe("QUEUED");
	});

	it("reads a run from GET /v1/runs/{run_id} with the id percent-encoded", async () => {
		const { calls, fetch } = recordingFetch({ run_id: "a/b", status: "RUNNING" });
		await client(fetch).getRun("a/b");
		expect(calls[0]?.url).toBe("https://api.adaptorch.com/v1/runs/a%2Fb");
	});

	it("passes only the documented list filters as query parameters", async () => {
		const { calls, fetch } = recordingFetch({ items: [] });
		await client(fetch).listRuns({ status: "SUCCEEDED", projectId: "p1", limit: 10, cursor: "c1" });

		const url = new URL(calls[0]?.url ?? "");
		expect(url.pathname).toBe("/v1/runs");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			status: "SUCCEEDED",
			project_id: "p1",
			limit: "10",
			cursor: "c1",
		});
	});

	it("omits absent list filters instead of sending empty values", async () => {
		const { calls, fetch } = recordingFetch({ items: [] });
		await client(fetch).listRuns();
		expect(calls[0]?.url).toBe("https://api.adaptorch.com/v1/runs");
	});

	it("cancels through PUT, not POST or DELETE", async () => {
		const { calls, fetch } = recordingFetch({ run_id: "r1", status: "CANCELLING" });
		await client(fetch).cancelRun("r1", "stale request");

		expect(calls[0]?.url).toBe("https://api.adaptorch.com/v1/runs/r1/cancel");
		expect(calls[0]?.init.method).toBe("PUT");
		expect(calls[0]?.init.body).toBe(JSON.stringify({ reason: "stale request" }));
	});

	it("maps the remaining reads to their documented paths", async () => {
		const cases: Array<[string, (c: AdaptOrchApiClient) => Promise<unknown>, unknown]> = [
			["/v1/capabilities", (c) => c.capabilities(), { api_version: "v1", features: [] }],
			["/v1/whoami", (c) => c.whoami(), { subject_id: "s1" }],
			["/v1/runs/r1/evidence", (c) => c.getEvidence("r1"), { run_id: "r1", checks: [] }],
			["/v1/runs/r1/artifacts", (c) => c.listArtifacts("r1"), { run_id: "r1", items: [] }],
		];
		for (const [path, call, body] of cases) {
			const { calls, fetch } = recordingFetch(body);
			await call(client(fetch));
			expect(calls[0]?.url, path).toBe(`https://api.adaptorch.com${path}`);
			expect(calls[0]?.init.method, path).toBe("GET");
		}
	});
});

describe("createAdaptOrchApiClientFromEnv", () => {
	it("returns undefined when no key is configured, so AdaptOrch stays opt-in", () => {
		const { fetch } = recordingFetch();
		expect(createAdaptOrchApiClientFromEnv(fetch, {})).toBeUndefined();
		expect(createAdaptOrchApiClientFromEnv(fetch, { ADAPTORCH_API_KEY: "   " })).toBeUndefined();
	});

	it("defaults to the hosted origin and honours an override", async () => {
		const { calls, fetch } = recordingFetch({ subject_id: "s1" });
		await createAdaptOrchApiClientFromEnv(fetch, { ADAPTORCH_API_KEY: "ado_k" })?.whoami();
		expect(calls[0]?.url).toBe(`${ADAPTORCH_DEFAULT_API_URL}/v1/whoami`);

		const override = recordingFetch({ subject_id: "s1" });
		await createAdaptOrchApiClientFromEnv(override.fetch, {
			ADAPTORCH_API_KEY: "ado_k",
			ADAPTORCH_API_URL: "http://localhost:8080",
		})?.whoami();
		expect(override.calls[0]?.url).toBe("http://localhost:8080/v1/whoami");
	});

	it("still refuses an unsafe override rather than downgrading silently", () => {
		const { fetch } = recordingFetch();
		expect(() =>
			createAdaptOrchApiClientFromEnv(fetch, {
				ADAPTORCH_API_KEY: "ado_k",
				ADAPTORCH_API_URL: "http://api.adaptorch.com",
			}),
		).toThrow(/https/i);
	});
});

describe("AdaptOrchApiClient failures", () => {
	it("raises a typed error carrying the status", async () => {
		const fetch: AdaptOrchFetch = async () => ({
			status: 404,
			json: async () => ({ code: "not_found", message: "no such run" }),
			text: async () => "",
		});
		await expect(client(fetch).getRun("r1")).rejects.toBeInstanceOf(AdaptOrchApiError);
		await expect(client(fetch).getRun("r1")).rejects.toMatchObject({ status: 404, code: "not_found" });
	});

	it("never puts the credential in an error message", async () => {
		const secret = "ado_super_secret_value";
		const fetch: AdaptOrchFetch = async () => {
			throw new Error(`connect failed for key ${secret}`);
		};
		await expect(client(fetch, secret).capabilities()).rejects.toThrow(
			expect.objectContaining({ message: expect.not.stringContaining(secret) }),
		);
	});

	it("rejects an unsafe base URL at construction, before any request", async () => {
		const { calls, fetch } = recordingFetch();
		expect(() => new AdaptOrchApiClient({ baseUrl: "http://api.adaptorch.com", apiKey: "ado_k", fetch })).toThrow(
			/https/i,
		);
		expect(calls).toHaveLength(0);
	});
});
