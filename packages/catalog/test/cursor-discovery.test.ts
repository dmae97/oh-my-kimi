import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import type * as net from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import { fetchCursorUsableModels } from "@oh-my-pi/pi-catalog/discovery/cursor";
import { GetUsableModelsResponseSchema, ModelDetailsSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

const servers = new Set<http2.Http2Server>();

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
	servers.clear();
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
});
