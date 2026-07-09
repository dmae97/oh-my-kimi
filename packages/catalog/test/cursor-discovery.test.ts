import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
// Import from source, not the package specifier: the workspace `node_modules`
// copy resolves to the primary checkout, not this worktree.
import { fetchCursorUsableModels } from "../src/discovery/cursor";
import { GetUsableModelsResponseSchema, ModelDetailsSchema } from "../src/discovery/cursor-gen/agent_pb";
import type { ModelSpec } from "../src/types";

const FIXTURE_MODEL_IDS = [
	// Reference-less ids from families whose native catalogs are multimodal.
	"claude-opus-4-8-99999999",
	"gpt-5.5-codex-20991231",
	"gemini-4-pro-exp",
	// Reference-less ids from text-only families.
	"composer-3",
	"grok-code-fast-2",
	// Bundled-reference ids: the reference stays authoritative.
	"claude-4.5-opus-high",
	"claude-4.6-opus-high",
	"composer-1",
];

let server: http2.Http2Server;
let baseUrl: string;

beforeAll(async () => {
	const response = create(GetUsableModelsResponseSchema, {
		models: FIXTURE_MODEL_IDS.map(modelId => create(ModelDetailsSchema, { modelId })),
	});
	const payload = Buffer.from(toBinary(GetUsableModelsResponseSchema, response));

	server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("end", () => {
			if (headers[":path"] !== "/agent.v1.AgentService/GetUsableModels") {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(payload);
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
	server?.close();
});

async function discover(): Promise<Map<string, ModelSpec<"cursor-agent">>> {
	const models = await fetchCursorUsableModels({ apiKey: "test-key", baseUrl });
	expect(models).not.toBeNull();
	return new Map((models ?? []).map(model => [model.id, model]));
}

describe("cursor discovery input modalities (issue #4726)", () => {
	it("classifies reference-less multimodal-family models as text+image", async () => {
		const byId = await discover();
		expect(byId.get("claude-opus-4-8-99999999")?.input).toEqual(["text", "image"]);
		expect(byId.get("gpt-5.5-codex-20991231")?.input).toEqual(["text", "image"]);
		expect(byId.get("gemini-4-pro-exp")?.input).toEqual(["text", "image"]);
	});

	it("keeps reference-less text-only families text-only", async () => {
		const byId = await discover();
		expect(byId.get("composer-3")?.input).toEqual(["text"]);
		expect(byId.get("grok-code-fast-2")?.input).toEqual(["text"]);
	});

	it("keeps bundled references authoritative for input modalities", async () => {
		const byId = await discover();
		// Bundled cursor references carry their own input classification; the
		// id-based inference must not override it in either direction.
		expect(byId.get("claude-4.5-opus-high")?.input).toEqual(["text", "image"]);
		expect(byId.get("claude-4.6-opus-high")?.input).toEqual(["text"]);
		expect(byId.get("composer-1")?.input).toEqual(["text"]);
	});

	it("preserves fallback defaults for reference-less models", async () => {
		const byId = await discover();
		const spec = byId.get("claude-opus-4-8-99999999");
		expect(spec?.provider).toBe("cursor");
		expect(spec?.api).toBe("cursor-agent");
		expect(spec?.contextWindow).toBe(200_000);
		expect(spec?.maxTokens).toBe(64_000);
		expect(spec?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});
