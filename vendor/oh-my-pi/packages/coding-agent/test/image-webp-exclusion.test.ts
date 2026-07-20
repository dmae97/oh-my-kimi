import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	modelLacksWebpSupport,
	normalizeModelContextImages,
	webpExclusionForModel,
} from "@oh-my-pi/pi-coding-agent/utils/image-loading";

// 1x1 red PNG seed, upscaled + re-encoded as WebP at test time so no binary
// fixture is checked in. Bun.Image sniffs format from bytes.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedWebP(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed)
		.resize(width, height, { filter: "nearest" })
		.webp({ quality: 90 })
		.bytes();
	return Buffer.from(upscaled).toBase64();
}

function buildLocalVisionModel(provider: string, api: Api = "openai-completions"): Model {
	return buildModel({
		id: "local-vision",
		name: "Local vision",
		api,
		provider,
		baseUrl: "http://localhost:8001/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

function buildStbVisionModel(provider: string, api: Api = "openai-completions"): Model {
	return buildModel({
		...buildLocalVisionModel(provider, api),
		imageInputDecoder: "stb",
	});
}

describe("modelLacksWebpSupport", () => {
	test("flags the local + cloud Ollama providers", () => {
		expect(modelLacksWebpSupport({ provider: "ollama", api: "openai-responses" })).toBe(true);
		expect(modelLacksWebpSupport({ provider: "ollama-cloud", api: "ollama-chat" })).toBe(true);
	});

	test("flags the ollama-chat api even behind a custom provider id", () => {
		// A proxy/custom provider still routes images through Ollama's STB decoder.
		expect(modelLacksWebpSupport({ provider: "my-local-ollama", api: "ollama-chat" })).toBe(true);
	});

	test("flags local model provider ids", () => {
		for (const provider of ["llama.cpp", "lm-studio", "local-server"]) {
			expect(modelLacksWebpSupport({ provider, api: "openai-completions" })).toBe(true);
		}
	});

	test("flags discovered STB-backed models even behind a custom provider id", () => {
		expect(
			modelLacksWebpSupport({
				provider: "my-renamed-llama",
				api: "openai-completions",
				imageInputDecoder: "stb",
			}),
		).toBe(true);
	});

	test("leaves WebP-capable providers and undefined untouched", () => {
		expect(modelLacksWebpSupport({ provider: "anthropic", api: "anthropic-messages" })).toBe(false);
		expect(modelLacksWebpSupport({ provider: "openai", api: "openai-responses" })).toBe(false);
		expect(modelLacksWebpSupport(undefined)).toBe(false);
	});

	test("webpExclusionForModel yields true|undefined so the OMP_NO_WEBP fallback survives", () => {
		// `true` forces exclusion for Ollama...
		expect(webpExclusionForModel({ provider: "ollama", api: "openai-responses" })).toBe(true);
		// ...but a capable model returns `undefined` (NOT `false`), so resizeImage's
		// env fallback still applies instead of being overridden off.
		expect(webpExclusionForModel({ provider: "openai", api: "openai-responses" })).toBeUndefined();
	});
});

describe("normalizeModelContextImages model-aware WebP exclusion", () => {
	const prior = Bun.env.OMP_NO_WEBP;

	beforeEach(() => {
		delete (Bun.env as Record<string, string | undefined>).OMP_NO_WEBP;
	});

	afterEach(() => {
		if (prior === undefined) delete (Bun.env as Record<string, string | undefined>).OMP_NO_WEBP;
		else Bun.env.OMP_NO_WEBP = prior;
	});

	test("re-encodes a WebP image out of WebP for an Ollama-family model", async () => {
		const [ollama] = getBundledModels("ollama-cloud");
		expect(ollama).toBeDefined();
		const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

		const result = await normalizeModelContextImages([webp], { model: ollama });
		expect(result).toHaveLength(1);
		const mime = result![0]!.mimeType;
		expect(mime).not.toBe("image/webp");
		expect(["image/png", "image/jpeg"]).toContain(mime);
	});

	test("re-encodes a WebP image out of WebP for local model provider ids", async () => {
		for (const provider of ["llama.cpp", "lm-studio", "local-server"]) {
			const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

			const result = await normalizeModelContextImages([webp], { model: buildLocalVisionModel(provider) });

			expect(result).toHaveLength(1);
			const mime = result![0]!.mimeType;
			expect(mime).not.toBe("image/webp");
			expect(["image/png", "image/jpeg"]).toContain(mime);
		}
	});

	test("re-encodes a WebP image out of WebP for renamed STB-backed local providers", async () => {
		const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

		const result = await normalizeModelContextImages([webp], {
			model: buildStbVisionModel("my-renamed-llama"),
		});

		expect(result).toHaveLength(1);
		const mime = result![0]!.mimeType;
		expect(mime).not.toBe("image/webp");
		expect(["image/png", "image/jpeg"]).toContain(mime);
	});

	test("keeps WebP for a WebP-capable model when OMP_NO_WEBP is unset", async () => {
		const [anthropic] = getBundledModels("anthropic");
		expect(anthropic).toBeDefined();
		const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

		const result = await normalizeModelContextImages([webp], { model: anthropic });

		expect(result?.[0]?.mimeType).toBe("image/webp");
	});
});
