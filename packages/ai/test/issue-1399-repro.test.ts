import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { streamBedrock } from "../src/providers/amazon-bedrock";
import { clearAwsCredentialCache } from "../src/providers/aws-credentials";
import type { Context, Model } from "../src/types";

const model: Model<"bedrock-converse-stream"> = {
	id: "zai.glm-5",
	name: "GLM-5",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 16_384,
};

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "say hi", timestamp: Date.now() }],
};

const awsEnvKeys = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEDROCK_SKIP_AUTH",
] as const;

describe("issue #1399: Bedrock bearer token precedence", () => {
	it("uses AWS_BEARER_TOKEN_BEDROCK without invoking profile credential_process", async () => {
		const previous = new Map<string, string | undefined>();
		for (const key of awsEnvKeys) previous.set(key, process.env[key]);

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bedrock-auth-"));
		try {
			const configPath = path.join(tempDir, "config");
			await Bun.write(
				configPath,
				[
					"[default]",
					"region = us-west-2",
					"credential_process = /bin/sh -c 'echo should-not-run >&2; exit 17'",
					"",
				].join("\n"),
			);

			delete process.env.AWS_ACCESS_KEY_ID;
			delete process.env.AWS_SECRET_ACCESS_KEY;
			delete process.env.AWS_SESSION_TOKEN;
			delete process.env.AWS_PROFILE;
			delete process.env.AWS_DEFAULT_REGION;
			delete process.env.AWS_BEDROCK_SKIP_AUTH;
			process.env.AWS_REGION = "us-west-2";
			process.env.AWS_CONFIG_FILE = configPath;
			process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(tempDir, "credentials");
			process.env.AWS_EC2_METADATA_DISABLED = "true";
			process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key";
			clearAwsCredentialCache();

			let requestHeaders: Headers | undefined;
			using _hook = hookFetch((_input, init) => {
				requestHeaders = new Headers(init?.headers);
				return new Response('{"message":"unauthorized"}', { status: 401 });
			});

			const result = await streamBedrock(model, context, {}).result();

			expect(requestHeaders?.get("authorization")).toBe("Bearer bedrock-api-key");
			expect(requestHeaders?.has("x-amz-date")).toBe(false);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Bedrock HTTP 401");
			expect(result.errorMessage).not.toContain("credential_process");
		} finally {
			for (const key of awsEnvKeys) {
				const value = previous.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			clearAwsCredentialCache();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
