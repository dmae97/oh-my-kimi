import { describe, expect, it } from "bun:test";
import { resolveDialect } from "@oh-my-pi/pi-coding-agent/sdk";

describe("resolveDialect", () => {
	it("uses GLM in auto mode only for models known not to support native tools", () => {
		expect(resolveDialect("auto", { supportsTools: false })).toBe("glm");
		expect(resolveDialect("auto", { supportsTools: true })).toBeUndefined();
		expect(resolveDialect("auto", {})).toBeUndefined();
		expect(resolveDialect("auto", undefined)).toBeUndefined();
	});

	it("keeps native unset and passes explicit in-band dialects through", () => {
		expect(resolveDialect("native", { supportsTools: false })).toBeUndefined();
		expect(resolveDialect("qwen3", undefined)).toBe("qwen3");
	});
});
