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
function snapshotAwsEnv(): () => void {
	const previous = new Map<string, string | undefined>();
	for (const key of awsEnvKeys) previous.set(key, process.env[key]);
	return () => {
		for (const key of awsEnvKeys) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		clearAwsCredentialCache();
	};
}

describe("issue #1399: Bedrock bearer token precedence", () => {
	it("uses AWS_BEARER_TOKEN_BEDROCK without invoking profile credential_process", async () => {
		const restoreAwsEnv = snapshotAwsEnv();

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
			restoreAwsEnv();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("ignores agent sentinel apiKey when AWS_BEARER_TOKEN_BEDROCK is available", async () => {
		const restoreAwsEnv = snapshotAwsEnv();
		try {
			delete process.env.AWS_ACCESS_KEY_ID;
			delete process.env.AWS_SECRET_ACCESS_KEY;
			delete process.env.AWS_SESSION_TOKEN;
			delete process.env.AWS_PROFILE;
			delete process.env.AWS_CONFIG_FILE;
			delete process.env.AWS_DEFAULT_REGION;
			delete process.env.AWS_BEDROCK_SKIP_AUTH;
			process.env.AWS_REGION = "us-west-2";
			process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(os.tmpdir(), "missing-aws-credentials");
			process.env.AWS_EC2_METADATA_DISABLED = "true";
			process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key";
			clearAwsCredentialCache();

			let requestHeaders: Headers | undefined;
			using _hook = hookFetch((_input, init) => {
				requestHeaders = new Headers(init?.headers);
				return new Response('{"message":"unauthorized"}', { status: 401 });
			});

			const result = await streamBedrock(model, context, { apiKey: "<authenticated>" }).result();

			expect(requestHeaders?.get("authorization")).toBe("Bearer bedrock-api-key");
			expect(requestHeaders?.get("authorization")).not.toBe("Bearer <authenticated>");
			expect(requestHeaders?.has("x-amz-date")).toBe(false);
			expect(result.stopReason).toBe("error");
		} finally {
			restoreAwsEnv();
		}
	});

	it("ignores agent sentinel apiKey when signing with AWS credentials", async () => {
		const restoreAwsEnv = snapshotAwsEnv();
		try {
			process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
			process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
			delete process.env.AWS_SESSION_TOKEN;
			delete process.env.AWS_PROFILE;
			delete process.env.AWS_CONFIG_FILE;
			delete process.env.AWS_SHARED_CREDENTIALS_FILE;
			delete process.env.AWS_DEFAULT_REGION;
			delete process.env.AWS_BEARER_TOKEN_BEDROCK;
			delete process.env.AWS_BEDROCK_SKIP_AUTH;
			process.env.AWS_REGION = "us-west-2";
			process.env.AWS_EC2_METADATA_DISABLED = "true";
			clearAwsCredentialCache();

			let requestHeaders: Headers | undefined;
			using _hook = hookFetch((_input, init) => {
				requestHeaders = new Headers(init?.headers);
				return new Response('{"message":"unauthorized"}', { status: 401 });
			});

			const result = await streamBedrock(model, context, { apiKey: "<authenticated>" }).result();

			const authorization = requestHeaders?.get("authorization");
			expect(authorization).toStartWith("AWS4-HMAC-SHA256 ");
			expect(authorization).toContain("Credential=AKIDEXAMPLE/");
			expect(authorization).not.toBe("Bearer <authenticated>");
			expect(requestHeaders?.has("x-amz-date")).toBe(true);
			expect(result.stopReason).toBe("error");
		} finally {
			restoreAwsEnv();
		}
	});
});
