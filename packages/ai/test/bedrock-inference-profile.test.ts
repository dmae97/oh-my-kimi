import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const profileArn = "arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company-opus-48";
const profileModel: Model<"bedrock-converse-stream"> = buildModel({
	id: profileArn,
	name: "Bedrock inference profile",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 1000000,
	maxTokens: 128000,
});

function userContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
	};
}

describe("Bedrock inference profile ARNs", () => {
	test("routes requests to the ARN region and preserves the ARN model id", async () => {
		const calls: string[] = [];
		const customFetch: FetchImpl = Object.assign(
			async (input: string | URL | Request, _init?: RequestInit) => {
				calls.push(String(input instanceof Request ? input.url : input));
				return new Response("nope", { status: 418 });
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamBedrock(profileModel, userContext(), {
			bearerToken: "test-token",
			fetch: customFetch,
			maxTokens: 16,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(calls).toEqual([
			`https://bedrock-runtime.us-east-2.amazonaws.com/model/${encodeURIComponent(profileArn)}/converse-stream`,
		]);
	});
});
