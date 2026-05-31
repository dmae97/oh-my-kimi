import { afterEach, describe, expect, it } from "bun:test";
import { getFastembedCacheDir } from "@oh-my-pi/pi-utils";
import "./setup";
import packageJson from "../package.json" with { type: "json" };
import {
	available,
	embed,
	embedQuery,
	getEmbeddingApiCallCountForTests,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
} from "../src/core/embeddings";
import { Mnemosyne } from "../src/core/memory";
import { withMnemosyneRuntimeOptions } from "../src/core/runtime-options";

const ENV_KEYS = [
	"NODE_ENV",
	"BUN_ENV",
	"MNEMOSYNE_NO_EMBEDDINGS",
	"MNEMOSYNE_EMBEDDING_MODEL",
	"MNEMOSYNE_EMBEDDING_API_URL",
	"MNEMOSYNE_EMBEDDING_API_KEY",
	"OPENROUTER_BASE_URL",
	"OPENROUTER_API_KEY",
	"OPENAI_API_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

function snapshotEnv(): Partial<Record<EnvKey, string>> {
	const snapshot: Partial<Record<EnvKey, string>> = {};
	for (const key of ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) {
			snapshot[key] = value;
		}
	}
	return snapshot;
}

function restoreEnv(snapshot: Partial<Record<EnvKey, string>>): void {
	for (const key of ENV_KEYS) {
		const value = snapshot[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

async function withEnv<T>(updates: Partial<Record<EnvKey, string | undefined>>, fn: () => Promise<T> | T): Promise<T> {
	const snapshot = snapshotEnv();
	try {
		for (const key of ENV_KEYS) {
			if (key in updates) {
				const value = updates[key];
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
		resetEmbeddingProviderForTests();
		return await fn();
	} finally {
		restoreEnv(snapshot);
		resetEmbeddingProviderForTests();
	}
}

afterEach(() => {
	resetEmbeddingProviderForTests();
});

describe("optional embeddings", () => {
	it("falls back cleanly when embeddings are disabled", async () => {
		await withEnv({ MNEMOSYNE_NO_EMBEDDINGS: "1" }, async () => {
			setEmbeddingProviderForTests({ embed: () => [[1, 2, 3]], available: () => true });

			expect(await available()).toBe(false);
			expect(await embedQuery("hello")).toBeNull();
			expect(await embed(["hello"])).toBeNull();
		});
	});

	it("uses a fake provider and caches single-query embeddings", async () => {
		await withEnv({ MNEMOSYNE_NO_EMBEDDINGS: undefined }, async () => {
			let calls = 0;
			setEmbeddingProviderForTests({
				embed(texts) {
					calls += 1;
					return texts.map(text => [text.length, text.charCodeAt(0) || 0]);
				},
				available: () => true,
			});

			expect(await available()).toBe(true);
			expect(await embedQuery("cache me")).toEqual(new Float32Array([8, 99]));
			expect(await embedQuery("cache me")).toEqual(new Float32Array([8, 99]));
			expect(calls).toBe(1);
		});
	});

	it("returns null instead of throwing when the provider fails", async () => {
		await withEnv({ MNEMOSYNE_NO_EMBEDDINGS: undefined }, async () => {
			setEmbeddingProviderForTests({
				embed() {
					throw new Error("provider unavailable");
				},
			});

			expect(await embed(["hello"])).toBeNull();
			expect(await embedQuery("hello")).toBeNull();
		});
	});

	it("calls an OpenAI-compatible custom embeddings endpoint without requiring an API key", async () => {
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				requests += 1;
				expect(request.headers.get("content-type")).toBe("application/json");
				expect(request.headers.get("user-agent")).toBe(`Oh-My-Pi/${packageJson.version}`);
				expect(request.headers.get("http-referer")).toBe("https://omp.sh/");
				expect(request.headers.get("x-openrouter-title")).toBe("Oh-My-Pi");
				expect(request.headers.get("x-openrouter-categories")).toBe("cli-agent");
				expect(request.headers.get("x-title")).toBeNull();
				expect(request.headers.get("authorization")).toBeNull();
				expect(new URL(request.url).pathname).toBe("/embeddings");
				const payload = (await request.json()) as { model: string; input: string[] };
				expect(payload.model).toBe("openai/text-embedding-3-small");
				return Response.json({
					data: payload.input.map((text, index) => ({ embedding: [text.length, index + 1] })),
				});
			},
		});

		try {
			await withEnv(
				{
					MNEMOSYNE_NO_EMBEDDINGS: undefined,
					MNEMOSYNE_EMBEDDING_MODEL: "openai/text-embedding-3-small",
					MNEMOSYNE_EMBEDDING_API_URL: server.url.toString().replace(/\/+$/, ""),
					MNEMOSYNE_EMBEDDING_API_KEY: undefined,
					OPENROUTER_API_KEY: undefined,
					OPENAI_API_KEY: undefined,
				},
				async () => {
					expect(await available()).toBe(true);
					expect(await embed(["hi", "world"])).toEqual([new Float32Array([2, 1]), new Float32Array([5, 2])]);
					expect(getEmbeddingApiCallCountForTests()).toBe(1);
				},
			);
			expect(requests).toBe(1);
		} finally {
			server.stop(true);
		}
	});
	it("normalizes Float32Array embeddings to Float32Array rows", async () => {
		await withEnv({ MNEMOSYNE_NO_EMBEDDINGS: undefined }, async () => {
			setEmbeddingProviderForTests({
				embed(texts) {
					// Simulate fastembed output: Array of Float32Array rows
					return texts.map(text => new Float32Array([text.length, text.charCodeAt(0) || 0, 42]));
				},
				available: () => true,
			});
			expect(await embed(["a", "bc"])).toEqual([new Float32Array([1, 97, 42]), new Float32Array([2, 98, 42])]);
		});
	});
	it("normalizes async Float32Array batches to Float32Array rows", async () => {
		await withEnv({ MNEMOSYNE_NO_EMBEDDINGS: undefined }, async () => {
			setEmbeddingProviderForTests({
				embed(texts) {
					// Simulate fastembed AsyncGenerator<Array<Float32Array>>
					return (async function* () {
						// Yield batches
						for (let i = 0; i < texts.length; i += 2) {
							const batch = texts.slice(i, i + 2);
							yield batch.map(
								text => new Float32Array([text.length, text.charCodeAt(0) || 0]),
							) as Float32Array[];
						}
					})();
				},
				available: () => true,
			});
			expect(await embed(["hi", "world", "test"])).toEqual([
				new Float32Array([2, 104]),
				new Float32Array([5, 119]),
				new Float32Array([4, 116]),
			]);
		});
	});
	it("rejects embeddings containing non-finite values", async () => {
		await withEnv({ MNEMOSYNE_NO_EMBEDDINGS: undefined }, async () => {
			// A single NaN/Infinity component silently zeroes a vector's cosine score, so the whole
			// result is rejected rather than stored as poison.
			for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
				setEmbeddingProviderForTests({ embed: () => [[1, bad, 3]], available: () => true });
				expect(await embed(["test"])).toBeNull();
			}
		});
	});

	it("lets constructor-scoped noEmbeddings override enabled providers", async () => {
		setEmbeddingProviderForTests({
			embed: texts => texts.map(() => [1, 2, 3]),
			available: () => true,
		});
		const memory = new Mnemosyne({ noEmbeddings: true });
		try {
			const result = await withMnemosyneRuntimeOptions(memory.runtimeOptions, () => embed(["hello"]));
			expect(result).toBeNull();
		} finally {
			memory.close();
		}
	});

	it("uses a constructor-scoped embedding provider", async () => {
		const memory = new Mnemosyne({
			embeddings: {
				provider: texts => texts.map(text => [text.length, text.charCodeAt(0) || 0]),
			},
		});
		try {
			const result = await withMnemosyneRuntimeOptions(memory.runtimeOptions, () => embedQuery("cache me"));
			expect(result).toEqual(new Float32Array([8, 99]));
		} finally {
			memory.close();
		}
	});

	it("retries local model initialization after a transient failure", async () => {
		await withEnv(
			{
				NODE_ENV: undefined,
				BUN_ENV: undefined,
				MNEMOSYNE_NO_EMBEDDINGS: undefined,
				MNEMOSYNE_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
				MNEMOSYNE_EMBEDDING_API_URL: undefined,
				OPENROUTER_BASE_URL: undefined,
				OPENROUTER_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			async () => {
				let initCalls = 0;
				const observedCacheDirs: Array<string | undefined> = [];
				setLocalModelInitializerForTests(async options => {
					initCalls += 1;
					observedCacheDirs.push(options.cacheDir);
					if (initCalls === 1) throw new Error("transient init failure");
					return {
						embed(texts) {
							return texts.map(text => [text.length, text.charCodeAt(0) || 0]);
						},
					};
				});

				expect(await embed(["first"])).toBeNull();
				expect(await embed(["second"])).toEqual([new Float32Array([6, 115])]);
				expect(initCalls).toBe(2);
				expect(observedCacheDirs).toEqual([getFastembedCacheDir(), getFastembedCacheDir()]);
				expect(observedCacheDirs.some(cacheDir => cacheDir?.includes(".hermes") ?? false)).toBe(false);
			},
		);
	});
});
