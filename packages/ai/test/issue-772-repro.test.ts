import { describe, expect, it } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";

import { xiaomiModelManagerOptions } from "../src/provider-models/openai-compat";
import { loginXiaomi } from "../src/utils/oauth/xiaomi";

const TOKEN_PLAN_HOST = "token-plan-ams.xiaomimimo.com";
const STANDARD_HOST = "api.xiaomimimo.com";

describe("issue-772: Xiaomi MiMo token-plan (tp-) keys", () => {
	it("loginXiaomi validates tp- keys against the token-plan host", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response("{}", { status: 200 });
		});

		await loginXiaomi({
			onAuth: () => {},
			onPrompt: async () => "tp-test-key",
			onProgress: () => {},
		});

		expect(seen).toHaveLength(1);
		const url = seen[0]!;
		expect(url).toContain(TOKEN_PLAN_HOST);
		expect(url).not.toContain(`${STANDARD_HOST}/`);
	});

	it("xiaomiModelManagerOptions discovers models from the token-plan host when given a tp- key", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({ apiKey: "tp-test-key" });
		await opts.fetchDynamicModels?.();

		expect(seen.length).toBeGreaterThan(0);
		const url = seen[0]!;
		expect(url).toContain(TOKEN_PLAN_HOST);
		expect(url).not.toContain(`${STANDARD_HOST}/`);
	});

	it("xiaomiModelManagerOptions still uses the standard host for sk- keys", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({ apiKey: "sk-test-key" });
		await opts.fetchDynamicModels?.();

		expect(seen.length).toBeGreaterThan(0);
		const url = seen[0]!;
		expect(url).toContain(STANDARD_HOST);
		expect(url).not.toContain(TOKEN_PLAN_HOST);
	});
});
