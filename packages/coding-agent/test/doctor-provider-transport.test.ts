import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import type { ProviderDoctorTransportRequest } from "../src/commands/doctor-provider.ts";
import {
	createProviderDoctorTransport,
	type ProviderDoctorPinnedConnection,
} from "../src/commands/doctor-provider-transport.ts";

const SECRET = "transport-secret-sentinel";

interface RecordedRequest {
	method?: string;
	url?: string;
	host?: string;
	authorization?: string;
	proxyAuthorization?: string;
	connection?: string;
	transferEncoding?: string;
	contentType?: string;
}

interface TestServer {
	port: number;
	requests: RecordedRequest[];
	close: () => Promise<void>;
}

const openServers: TestServer[] = [];

async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<TestServer> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer((request, response) => {
		requests.push({
			method: request.method,
			url: request.url,
			host: request.headers.host,
			authorization: request.headers.authorization,
			proxyAuthorization: request.headers["proxy-authorization"],
			connection: request.headers.connection,
			transferEncoding: request.headers["transfer-encoding"],
			contentType: request.headers["content-type"],
		});
		handler(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const testServer: TestServer = {
		port,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
	openServers.push(testServer);
	return testServer;
}

function transportRequest(
	url: string,
	overrides: Partial<ProviderDoctorTransportRequest> = {},
): ProviderDoctorTransportRequest {
	return {
		url: new URL(url),
		method: "GET",
		redirect: "manual",
		signal: new AbortController().signal,
		addressPolicy: { kind: "loopback-only", requireAddressPinning: false },
		createHeaders: () => new Headers(),
		...overrides,
	};
}

const PUBLIC_POLICY = { kind: "public", requireAddressPinning: true } as const;

describe("provider doctor transport", () => {
	afterEach(async () => {
		while (openServers.length > 0) {
			await openServers.pop()?.close();
		}
	});

	test("declares resolved-address pinning", () => {
		expect(createProviderDoctorTransport().pinsResolvedAddress).toBe(true);
	});

	test("performs a GET against a loopback literal and returns only the status", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "x-secret-header": SECRET });
			response.end(`{"secret":"${SECRET}"}`);
		});
		const transport = createProviderDoctorTransport();
		const response = await transport.request(
			transportRequest(`http://127.0.0.1:${server.port}/v1/models`, {
				createHeaders: () => new Headers({ Authorization: `Bearer ${SECRET}` }),
			}),
		);

		expect(response).toEqual({ status: 200 });
		expect(Object.keys(response)).toEqual(["status"]);
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]).toMatchObject({
			method: "GET",
			url: "/v1/models",
			host: `127.0.0.1:${server.port}`,
			authorization: `Bearer ${SECRET}`,
		});
	});

	test("awaits header materialization inside the transport request", async () => {
		const server = await startServer((_request, response) => response.end());
		let materialized = false;
		const transport = createProviderDoctorTransport();
		await transport.request(
			transportRequest(`http://127.0.0.1:${server.port}/v1`, {
				createHeaders: async () => {
					await Promise.resolve();
					materialized = true;
					return new Headers({ Authorization: `Bearer ${SECRET}` });
				},
			}),
		);

		expect(materialized).toBe(true);
		expect(server.requests[0]?.authorization).toBe(`Bearer ${SECRET}`);
	});

	test("rejects duplicate case-variant Authorization values before connecting", async () => {
		const server = await startServer((_request, response) => response.end());
		const headers = new Headers({ Authorization: `Bearer first-${SECRET}` });
		headers.append("authorization", `Bearer second-${SECRET}`);
		const transport = createProviderDoctorTransport();

		await expect(
			transport.request(
				transportRequest(`http://127.0.0.1:${server.port}/v1`, {
					createHeaders: () => headers,
				}),
			),
		).rejects.toThrow();
		expect(server.requests).toHaveLength(0);
	});

	test("strips caller-supplied sensitive proxy and hop-by-hop framing headers", async () => {
		const server = await startServer((_request, response) => response.end());
		const transport = createProviderDoctorTransport();
		await transport.request(
			transportRequest(`http://127.0.0.1:${server.port}/v1`, {
				createHeaders: () =>
					new Headers({
						Connection: "upgrade",
						Host: `attacker-${SECRET}.example.test`,
						"Proxy-Authorization": `Bearer ${SECRET}`,
						"Transfer-Encoding": "chunked",
					}),
			}),
		);

		expect(server.requests[0]).toMatchObject({ host: `127.0.0.1:${server.port}` });
		expect(server.requests[0]?.proxyAuthorization).toBeUndefined();
		expect(server.requests[0]?.transferEncoding).toBeUndefined();
		expect(server.requests[0]?.connection).not.toBe("upgrade");
	});

	test("sanitizes header materialization failures and never connects", async () => {
		const server = await startServer((_request, response) => response.end());
		const transport = createProviderDoctorTransport();
		let caught: unknown;
		try {
			await transport.request(
				transportRequest(`http://127.0.0.1:${server.port}/v1`, {
					createHeaders: async () => {
						throw new Error(`header resolver leaked ${SECRET}`);
					},
				}),
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(String(caught)).toContain("authentication");
		expect(`${String(caught)} ${(caught as Error).stack ?? ""}`).not.toContain(SECRET);
		expect(server.requests).toHaveLength(0);
	});

	test("does not follow redirects and returns the redirect status", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(302, { location: `http://127.0.0.1:1/${SECRET}` });
			response.end();
		});
		const transport = createProviderDoctorTransport();
		const response = await transport.request(transportRequest(`http://127.0.0.1:${server.port}/v1`));

		expect(response).toEqual({ status: 302 });
		expect(server.requests).toHaveLength(1);
	});

	test("resolves as soon as the status is known without buffering an unbounded body", async () => {
		let stream: NodeJS.Timeout | undefined;
		const server = await startServer((_request, response) => {
			response.writeHead(200);
			stream = setInterval(() => response.write("x".repeat(65_536)), 1);
		});
		const transport = createProviderDoctorTransport();
		const response = await transport.request(transportRequest(`http://127.0.0.1:${server.port}/v1`));
		clearInterval(stream);

		expect(response).toEqual({ status: 200 });
	});

	test("rejects when the composed signal aborts a hung request", async () => {
		const server = await startServer(() => {
			// Never respond.
		});
		const transport = createProviderDoctorTransport();
		await expect(
			transport.request(
				transportRequest(`http://127.0.0.1:${server.port}/v1`, { signal: AbortSignal.timeout(100) }),
			),
		).rejects.toThrow();
	});

	test("rejects a pre-aborted signal without contacting the server", async () => {
		const server = await startServer((_request, response) => response.end());
		const controller = new AbortController();
		controller.abort();
		const transport = createProviderDoctorTransport();
		await expect(
			transport.request(transportRequest(`http://127.0.0.1:${server.port}/v1`, { signal: controller.signal })),
		).rejects.toThrow();
		expect(server.requests).toHaveLength(0);
	});

	test("rechecks abort after DNS before materializing auth or connecting", async () => {
		const controller = new AbortController();
		let authCalls = 0;
		let connections = 0;
		const transport = createProviderDoctorTransport({
			lookup: async () => {
				controller.abort();
				return ["127.0.0.1"];
			},
			createConnection: () => {
				connections++;
				throw new Error("must not connect");
			},
		});

		await expect(
			transport.request(
				transportRequest("http://provider.example.test/v1", {
					signal: controller.signal,
					createHeaders: () => {
						authCalls++;
						return new Headers({ Authorization: `Bearer ${SECRET}` });
					},
				}),
			),
		).rejects.toThrow();
		expect(authCalls).toBe(0);
		expect(connections).toBe(0);
	});

	test("rechecks abort after async auth before connecting or posting", async () => {
		const controller = new AbortController();
		let connections = 0;
		const transport = createProviderDoctorTransport({
			createConnection: () => {
				connections++;
				throw new Error("must not connect");
			},
		});

		await expect(
			transport.request(
				transportRequest("http://127.0.0.1:9/v1/chat/completions", {
					method: "POST",
					body: "{}",
					contentType: "application/json",
					signal: controller.signal,
					createHeaders: async () => {
						controller.abort();
						return new Headers({ Authorization: `Bearer ${SECRET}` });
					},
				}),
			),
		).rejects.toThrow();
		expect(connections).toBe(0);
	});

	test("rejects unsupported methods without issuing a request", async () => {
		const server = await startServer((_request, response) => response.end());
		const transport = createProviderDoctorTransport();
		await expect(
			transport.request(transportRequest(`http://127.0.0.1:${server.port}/v1`, { method: "DELETE" as never })),
		).rejects.toThrow();
		expect(server.requests).toHaveLength(0);
	});

	test("performs a bounded JSON POST and returns only the status", async () => {
		const bodies: string[] = [];
		const server = await startServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				bodies.push(Buffer.concat(chunks).toString("utf-8"));
				response.writeHead(200);
				response.end(`{"secret":"${SECRET}"}`);
			});
		});
		const transport = createProviderDoctorTransport();
		const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
		const response = await transport.request(
			transportRequest(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
				method: "POST",
				body,
				contentType: "application/json",
			}),
		);

		expect(response).toEqual({ status: 200 });
		expect(Object.keys(response)).toEqual(["status"]);
		expect(bodies).toEqual([body]);
		expect(server.requests[0]).toMatchObject({
			method: "POST",
			url: "/v1/chat/completions",
			contentType: "application/json",
		});
	});

	test("does not follow POST redirects", async () => {
		const server = await startServer((request, response) => {
			request.resume();
			response.writeHead(307, { location: `http://127.0.0.1:1/${SECRET}` });
			response.end();
		});
		const transport = createProviderDoctorTransport();
		const response = await transport.request(
			transportRequest(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
				method: "POST",
				body: "{}",
				contentType: "application/json",
			}),
		);
		expect(response).toEqual({ status: 307 });
		expect(server.requests).toHaveLength(1);
	});

	test.each([
		["oversized body", { method: "POST", body: `{"pad":"${"x".repeat(5_000)}"}`, contentType: "application/json" }],
		["missing content type", { method: "POST", body: "{}" }],
		["missing body", { method: "POST", contentType: "application/json" }],
		["GET with body", { method: "GET", body: "{}" }],
	] as const)("rejects invalid request shapes (%s) without connecting", async (_name, overrides) => {
		const server = await startServer((_request, response) => response.end());
		const transport = createProviderDoctorTransport();
		await expect(
			transport.request(
				transportRequest(
					`http://127.0.0.1:${server.port}/v1`,
					overrides as Partial<ProviderDoctorTransportRequest>,
				),
			),
		).rejects.toThrow();
		expect(server.requests).toHaveLength(0);
	});

	test("rejects on DNS failure without echoing the hostname or credentials", async () => {
		const transport = createProviderDoctorTransport({
			lookup: async () => {
				throw new Error(`resolver saw secret-host.internal.example ${SECRET}`);
			},
		});
		let caught: unknown;
		try {
			await transport.request(
				transportRequest(`http://secret-host.internal.example/v1?key=${SECRET}`, {
					addressPolicy: PUBLIC_POLICY,
					method: "POST",
					body: `{"authorization":"${SECRET}"}`,
					contentType: "application/json",
				}),
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		const serialized = `${String(caught)} ${(caught as Error).stack ?? ""}`;
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain("secret-host.internal.example");
	});

	test("rejects unsupported URL schemes", async () => {
		const transport = createProviderDoctorTransport();
		await expect(transport.request(transportRequest("ftp://127.0.0.1/v1"))).rejects.toThrow();
	});

	test("loopback-only policy rejects a public literal address without resolving", async () => {
		let lookups = 0;
		const transport = createProviderDoctorTransport({
			lookup: async () => {
				lookups++;
				return ["203.0.113.7"];
			},
		});
		await expect(transport.request(transportRequest("http://203.0.113.7:9/v1"))).rejects.toThrow();
		expect(lookups).toBe(0);
	});

	test("loopback-only policy rejects hostnames that resolve to non-loopback addresses", async () => {
		let lookups = 0;
		const transport = createProviderDoctorTransport({
			lookup: async () => {
				lookups++;
				return ["10.0.0.5"];
			},
		});
		await expect(transport.request(transportRequest("http://internal.example.test/v1"))).rejects.toThrow();
		expect(lookups).toBe(1);
	});

	test("loopback-only policy rejects mixed loopback and non-loopback resolutions", async () => {
		const transport = createProviderDoctorTransport({ lookup: async () => ["127.0.0.1", "10.0.0.5"] });
		await expect(transport.request(transportRequest("http://internal.example.test/v1"))).rejects.toThrow();
	});

	test("loopback-only policy connects to the pinned loopback resolution", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(204);
			response.end();
		});
		let lookups = 0;
		const transport = createProviderDoctorTransport({
			lookup: async () => {
				lookups++;
				return ["127.0.0.1"];
			},
		});
		const response = await transport.request(transportRequest(`http://localhost:${server.port}/health`));

		expect(response).toEqual({ status: 204 });
		expect(lookups).toBe(1);
		expect(server.requests[0]?.host).toBe(`localhost:${server.port}`);
	});

	test.each([[["10.0.0.5"]], [["169.254.169.254"]], [["127.0.0.1"]], [["::1"]], [["203.0.113.7", "192.168.1.1"]]])(
		"public policy rejects blocked resolution %j without connecting",
		async (addresses) => {
			let connections = 0;
			const transport = createProviderDoctorTransport({
				lookup: async () => addresses,
				createConnection: () => {
					connections++;
					throw new Error("must not connect");
				},
			});
			await expect(
				transport.request(transportRequest("http://api.example.test/v1", { addressPolicy: PUBLIC_POLICY })),
			).rejects.toThrow();
			expect(connections).toBe(0);
		},
	);

	test("public policy pins the socket to the resolved address and keeps the original host header", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200);
			response.end();
		});
		let lookups = 0;
		const pinned: ProviderDoctorPinnedConnection[] = [];
		const transport = createProviderDoctorTransport({
			lookup: async () => {
				lookups++;
				return ["203.0.113.7"];
			},
			createConnection: (connection): Socket => {
				pinned.push(connection);
				return connect(server.port, "127.0.0.1");
			},
		});
		const response = await transport.request(
			transportRequest(`http://api.example.test:${server.port}/v1/models`, { addressPolicy: PUBLIC_POLICY }),
		);

		expect(response).toEqual({ status: 200 });
		expect(lookups).toBe(1);
		expect(pinned).toEqual([{ address: "203.0.113.7", port: server.port, hostname: "api.example.test" }]);
		expect(server.requests[0]?.host).toBe(`api.example.test:${server.port}`);
	});

	test("public policy uses a literal public IP without any DNS lookup", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200);
			response.end();
		});
		let lookups = 0;
		const pinned: ProviderDoctorPinnedConnection[] = [];
		const transport = createProviderDoctorTransport({
			lookup: async () => {
				lookups++;
				return ["203.0.113.7"];
			},
			createConnection: (connection): Socket => {
				pinned.push(connection);
				return connect(server.port, "127.0.0.1");
			},
		});
		const response = await transport.request(
			transportRequest(`http://203.0.113.9:${server.port}/v1`, { addressPolicy: PUBLIC_POLICY }),
		);

		expect(response).toEqual({ status: 200 });
		expect(lookups).toBe(0);
		expect(pinned).toEqual([{ address: "203.0.113.9", port: server.port, hostname: "203.0.113.9" }]);
	});

	test("failures never echo the hostname, address, or credentials", async () => {
		const transport = createProviderDoctorTransport({ lookup: async () => ["10.99.88.77"] });
		let caught: unknown;
		try {
			await transport.request(
				transportRequest(`http://secret-host.internal.example/v1?key=${SECRET}`, {
					addressPolicy: PUBLIC_POLICY,
					createHeaders: () => new Headers({ Authorization: `Bearer ${SECRET}` }),
				}),
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		const serialized = `${String(caught)} ${(caught as Error).stack ?? ""}`;
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain("secret-host.internal.example");
		expect(serialized).not.toContain("10.99.88.77");
	});
});
