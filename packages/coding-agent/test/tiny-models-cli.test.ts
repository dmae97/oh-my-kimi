import { describe, expect, it } from "bun:test";
import { resolveModels } from "@oh-my-pi/pi-coding-agent/cli/tiny-models-cli";
import { TINY_LOCAL_MODELS } from "@oh-my-pi/pi-coding-agent/tiny/models";

describe("tiny-models download model resolution", () => {
	it("excludes load-blocked models from `all` so the bulk prefetch stays green", () => {
		const unsupported = TINY_LOCAL_MODELS.filter(spec => spec.unsupportedReason).map(spec => spec.key);
		// Guard: keep this regression meaningful — at least one registry entry must be load-blocked.
		expect(unsupported.length).toBeGreaterThan(0);

		const all = resolveModels("all");
		for (const key of unsupported) expect(all).not.toContain(key);

		const usable = TINY_LOCAL_MODELS.filter(spec => !spec.unsupportedReason).map(spec => spec.key);
		for (const key of usable) expect(all).toContain(key);
	});

	it("still resolves an explicitly requested unsupported model (only `all` is filtered)", () => {
		const blocked = TINY_LOCAL_MODELS.find(spec => spec.unsupportedReason);
		expect(blocked).toBeDefined();
		if (!blocked) return;
		expect(resolveModels(blocked.key)).toEqual([blocked.key]);
	});
});
