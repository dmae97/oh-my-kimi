import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "../src/model-manager";
import { googleVertexModelManagerOptions } from "../src/provider-models/google";
import { __resetVertexTokenCache } from "../src/providers/google-auth";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

describe("google-vertex model discovery", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-vertex-models-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		__resetVertexTokenCache();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
			dbPath = "";
		}
	});

	it("uses the Vertex OpenAI-compatible model list as the authoritative project catalog", async () => {
		const urls: string[] = [];
		const options = googleVertexModelManagerOptions({
			project: "vertex-project",
			location: "global",
			fetch: async input => {
				const url = input instanceof Request ? input.url : input.toString();
				urls.push(url);
				if (url === METADATA_TOKEN_URL || url === OAUTH_TOKEN_URL) {
					return new Response(JSON.stringify({ access_token: "vertex-token", expires_in: 3600 }));
				}
				if (
					url.startsWith(
						"https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi/models",
					)
				) {
					return new Response(
						JSON.stringify({
							data: [
								{ id: "zai-org/glm-4.7-maas", displayName: "GLM-4.7" },
								{
									name: "projects/vertex-project/locations/global/publishers/anthropic/models/claude-sonnet-4-5",
									displayName: "Claude Sonnet 4.5",
								},
							],
						}),
					);
				}
				return new Response("not found", { status: 404 });
			},
		});

		const result = await resolveProviderModels({ ...options, cacheDbPath: dbPath }, "online");

		expect(result.stale).toBe(false);
		expect(result.models.map(model => model.id)).toEqual(["anthropic/claude-sonnet-4-5", "zai-org/glm-4.7-maas"]);
		expect(result.models.every(model => model.provider === "google-vertex")).toBe(true);
		expect(result.models.every(model => model.api === "openai-completions")).toBe(true);
		expect(
			result.models.every(
				model =>
					model.baseUrl ===
					"https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
			),
		).toBe(true);
		expect(result.models.some(model => model.id === "gemini-1.5-pro")).toBe(false);
		expect(urls).toContain(
			"https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi/models?pageSize=100",
		);
	});
});
