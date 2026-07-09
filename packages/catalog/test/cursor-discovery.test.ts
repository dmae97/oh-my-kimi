import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http2 from "node:http2";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { fetchCursorUsableModels } from "@oh-my-pi/pi-catalog/discovery/cursor";
import { GetUsableModelsResponseSchema, ModelDetailsSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { cursorModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const servers = new Set<http2.Http2Server>();
const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.all(
		[...servers].map(server => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
			return promise;
		}),
	);
	await Promise.all([...tempDirs].map(dir => fs.rm(dir, { recursive: true, force: true })));
	servers.clear();
	tempDirs.clear();
});

function requireTcpAddress(address: string | net.AddressInfo | null): net.AddressInfo {
	if (!address || typeof address === "string") {
		throw new Error("HTTP/2 test server did not bind to a TCP address");
	}
	return address;
}

function startCursorDiscoveryServer(body: Uint8Array): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const server = http2.createServer();
	servers.add(server);
	server.once("error", reject);
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.respond({ ":status": 200, "content-type": "application/proto" });
		stream.end(Buffer.from(body));
	});
	server.listen(0, "127.0.0.1", () => {
		resolve(`http://127.0.0.1:${requireTcpAddress(server.address()).port}`);
	});
	return promise;
}

async function createTempCachePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-cache-"));
	tempDirs.add(dir);
	return path.join(dir, "models.db");
}

function cursorModelSpec(id: string): ModelSpec<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

describe("fetchCursorUsableModels", () => {
	it("preserves Cursor max-mode metadata from GetUsableModels", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, {
					modelId: "cursor-composer-max",
					displayName: "Cursor Composer Max",
					maxMode: true,
				}),
			],
		});
		const baseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({
				id: "cursor-composer-max",
				name: "Cursor Composer Max",
				api: "cursor-agent",
				provider: "cursor",
				cursorMaxMode: true,
			}),
		]);
	});

	it("ignores Cursor cache rows written before max-mode metadata was persisted", async () => {
		const cacheDbPath = await createTempCachePath();
		const staleSpec = cursorModelSpec("cursor-composer-max");
		await resolveProviderModels(
			{
				providerId: "cursor",
				cacheProviderId: "cursor",
				cacheDbPath,
				staticModels: [],
				fetchDynamicModels: async () => [staleSpec],
				now: () => 1,
			},
			"online",
		);

		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, {
					modelId: staleSpec.id,
					displayName: staleSpec.name,
					maxMode: true,
				}),
			],
		});
		const baseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));
		const result = await resolveProviderModels(
			{
				...cursorModelManagerOptions({ apiKey: "test-token", baseUrl }),
				cacheDbPath,
				staticModels: [],
				now: () => 2,
			},
			"online-if-uncached",
		);

		expect(result.models).toEqual([
			expect.objectContaining({
				id: staleSpec.id,
				cursorMaxMode: true,
			}),
		]);
	});
});
