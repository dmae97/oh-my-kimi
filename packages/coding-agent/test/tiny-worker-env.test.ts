import { describe, expect, it } from "bun:test";
import { tinyWorkerEnvOverlay } from "../src/tiny/title-client";

describe("tinyWorkerEnvOverlay", () => {
	it("maps non-default settings onto the worker env vars when neither is already set", () => {
		expect(tinyWorkerEnvOverlay({}, "cuda", "fp16")).toEqual({
			PI_TINY_DEVICE: "cuda",
			PI_TINY_DTYPE: "fp16",
		});
	});

	it("lets a present env var win over the persisted setting", () => {
		expect(tinyWorkerEnvOverlay({ PI_TINY_DEVICE: "cpu" }, "cuda", "fp16")).toEqual({ PI_TINY_DTYPE: "fp16" });
		expect(tinyWorkerEnvOverlay({ PI_TINY_DTYPE: "q8" }, "cuda", "fp16")).toEqual({ PI_TINY_DEVICE: "cuda" });
	});

	it("omits a var when its setting is the default sentinel or unset", () => {
		expect(tinyWorkerEnvOverlay({}, "default", "default")).toEqual({});
		expect(tinyWorkerEnvOverlay({}, undefined, undefined)).toEqual({});
	});
});
