import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { clearCustomApis, registerCustomApi } from "../src/api-registry";
import { stream } from "../src/stream";
import type { AssistantMessage, FetchImpl, Model } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";
import { wrapFetchForRequestDebug } from "../src/utils/request-debug";

const enc = new TextEncoder();

let previousCwd: string;
let previousDebugFlag: string | undefined;
let tempDir: string | undefined;

beforeEach(async () => {
	previousCwd = process.cwd();
	previousDebugFlag = Bun.env.PI_REQ_DEBUG;
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-req-debug-"));
	process.chdir(tempDir);
});

afterEach(async () => {
	clearCustomApis();
	process.chdir(previousCwd);
	if (previousDebugFlag === undefined) delete Bun.env.PI_REQ_DEBUG;
	else Bun.env.PI_REQ_DEBUG = previousDebugFlag;
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

function chunkedResponse(chunks: Uint8Array[]): Response {
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (index >= chunks.length) {
					controller.close();
					return;
				}
				controller.enqueue(chunks[index++]!);
			},
		}),
		{ status: 201, statusText: "Created", headers: { "x-request-id": "resp-1", "content-type": "text/plain" } },
	);
}

async function debugFiles(): Promise<{ requestPath: string; responsePath: string }> {
	const files = await fs.readdir(tempDir!);
	const requestPath = files.find(file => /^rr-session-\d+\.json$/.test(file));
	expect(requestPath).toBeDefined();
	const responsePath = requestPath!.replace(/\.json$/, ".res.log");
	expect(files.includes(responsePath)).toBe(true);
	return { requestPath: path.join(tempDir!, requestPath!), responsePath: path.join(tempDir!, responsePath) };
}

function splitResponseLog(bytes: Uint8Array): { headers: string; body: Uint8Array } {
	const separator = enc.encode("\r\n\r\n");
	let separatorIndex = -1;
	for (let i = 0; i <= bytes.length - separator.length; i++) {
		let matched = true;
		for (let j = 0; j < separator.length; j++) {
			if (bytes[i + j] !== separator[j]) {
				matched = false;
				break;
			}
		}
		if (matched) {
			separatorIndex = i;
			break;
		}
	}
	expect(separatorIndex).toBeGreaterThanOrEqual(0);
	return {
		headers: new TextDecoder().decode(bytes.subarray(0, separatorIndex)),
		body: bytes.subarray(separatorIndex + separator.length),
	};
}

describe("PI_REQ_DEBUG request/response recording", () => {
	it("leaves fetch untouched when the flag is disabled", () => {
		delete Bun.env.PI_REQ_DEBUG;
		const fetchImpl: FetchImpl = async () => new Response("ok");
		expect(wrapFetchForRequestDebug(fetchImpl)).toBe(fetchImpl);
	});

	it("records request JSON before fetch and raw response bytes after headers", async () => {
		Bun.env.PI_REQ_DEBUG = "1";
		const responseBody = new Uint8Array([0x66, 0x69, 0x72, 0x73, 0x74, 0x00, 0xff, 0x0a]);
		const fetchImpl: FetchImpl = async () => chunkedResponse([responseBody.subarray(0, 5), responseBody.subarray(5)]);
		const wrapped = wrapFetchForRequestDebug(fetchImpl);

		const response = await wrapped("https://provider.test/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer test-token" },
			body: JSON.stringify({ model: "debug-model", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBody);

		const { requestPath, responsePath } = await debugFiles();
		const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as Record<string, unknown>;
		expect(request).toMatchObject({
			protocol: "http",
			method: "POST",
			url: "https://provider.test/v1/messages",
			body: { model: "debug-model", messages: [{ role: "user", content: "hi" }] },
		});
		expect(request.headers).toMatchObject({ authorization: "Bearer test-token", "content-type": "application/json" });

		const log = splitResponseLog(await fs.readFile(responsePath));
		expect(log.headers).toContain("HTTP 201 Created");
		expect(log.headers).toContain("content-type: text/plain");
		expect(log.headers).toContain("x-request-id: resp-1");
		expect(log.body).toEqual(responseBody);
	});

	it("keeps the partial response log when the response body is cancelled", async () => {
		Bun.env.PI_REQ_DEBUG = "1";
		const firstChunk = enc.encode("partial");
		let sent = false;
		const fetchImpl: FetchImpl = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (sent) return;
						sent = true;
						controller.enqueue(firstChunk);
					},
				}),
				{ status: 201, statusText: "Created", headers: { "content-type": "text/plain" } },
			);
		const response = await wrapFetchForRequestDebug(fetchImpl)("https://provider.test/stream", { method: "POST" });

		const reader = response.body!.getReader();
		const firstRead = await reader.read();
		expect(firstRead.value).toEqual(firstChunk);
		await reader.cancel("turn aborted");

		const { responsePath } = await debugFiles();
		const log = splitResponseLog(await fs.readFile(responsePath));
		expect(log.headers).toContain("HTTP 201 Created");
		expect(log.body).toEqual(firstChunk);
	});

	it("injects the debug fetch into provider options when callers did not pass fetch", async () => {
		Bun.env.PI_REQ_DEBUG = "1";
		using _hook = hookFetch(() => new Response("ok", { headers: { "x-debug": "yes" } }));
		registerCustomApi("req-debug-test", (_model, _context, options) => {
			const events = new AssistantMessageEventStream();
			void (async () => {
				const fetchImpl = options?.fetch;
				if (!fetchImpl) throw new Error("missing fetch");
				const response = await fetchImpl("https://provider.test/custom", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ok: true }),
				});
				await response.text();
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					provider: "test",
					api: "req-debug-test",
					model: "debug-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				events.end(message);
			})().catch(error => events.fail(error));
			return events;
		});

		const model: Model = {
			id: "debug-model",
			name: "Debug Model",
			api: "req-debug-test",
			provider: "test",
			baseUrl: "https://provider.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		};
		const events = stream(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "key" },
		);
		await events.result();

		const { requestPath, responsePath } = await debugFiles();
		const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as Record<string, unknown>;
		expect(request.url).toBe("https://provider.test/custom");
		expect(request.body).toEqual({ ok: true });
		const log = splitResponseLog(await fs.readFile(responsePath));
		expect(log.headers).toContain("x-debug: yes");
		expect(new TextDecoder().decode(log.body)).toBe("ok");
	});
});
